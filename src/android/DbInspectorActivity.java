package com.hfps.dbinspector;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full-screen host for the bundled db-inspector.html page.
 *
 * Bridge protocol: the page calls DbInspectorAndroid.invoke(callId, action, argsJson), which
 * returns immediately; the work runs on a single background thread and the result is
 * delivered as window.__dbiResolve(callId, envelopeJson), where the envelope is
 * {"ok":true,"data":...} or {"ok":false,"error":"..."}. Keeping it asynchronous means a slow
 * query never freezes the page (and can be interrupted from it).
 */
public class DbInspectorActivity extends Activity {

    static final String EXTRA_OPTIONS = "com.hfps.dbinspector.OPTIONS";
    private static final String PREFS = "hfps_db_inspector";
    private static final int REQUEST_SAVE = 7301;
    private static final int REQUEST_PICK = 7302;
    private static final int MAX_IMPORT_BYTES = 10 * 1024 * 1024;

    private WebView webView;
    private FrameLayout root;
    private DbInspectorEngine engine;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    // State for the in-flight Storage Access Framework request (one at a time).
    private int pendingCallId = -1;
    private byte[] pendingSaveBytes;
    private File pendingSaveFile;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        engine = new DbInspectorEngine(this);

        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.addJavascriptInterface(new Bridge(), "DbInspectorAndroid");
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        applyInsets();
        setContentView(root);
        registerBackCallback();

        webView.loadUrl("file:///android_asset/db-inspector.html");
    }

    /**
     * Android 15+ forces edge-to-edge; pad the page by the system bars (and the keyboard) so
     * the header never sits under the status bar and inputs stay visible while typing.
     */
    private void applyInsets() {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                left = bars.left; top = bars.top; right = bars.right;
                bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });
    }

    /**
     * Apps targeting SDK 36 get predictive back by default, where onBackPressed() is no longer
     * called — so on API 33+ back is also routed through an OnBackInvokedCallback.
     */
    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    /** Lets the page close its own modals / sub-views first; leaves when it has nothing left. */
    private void handleBack() {
        webView.evaluateJavascript("window.__dbiBack ? window.__dbiBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onDestroy() {
        worker.shutdownNow();
        engine.interrupt();
        engine.closeAll();
        if (webView != null) {
            webView.removeJavascriptInterface("DbInspectorAndroid");
            webView.destroy();
        }
        super.onDestroy();
    }

    private void resolve(int callId, Object data) {
        String envelope;
        try {
            envelope = new JSONObject().put("ok", true).put("data", data == null ? JSONObject.NULL : data).toString();
        } catch (Exception e) {
            envelope = "{\"ok\":false,\"error\":\"Serialization failed\"}";
        }
        deliver(callId, envelope);
    }

    private void reject(int callId, Throwable error) {
        String message = error.getMessage() != null ? error.getMessage() : error.getClass().getSimpleName();
        String envelope;
        try {
            envelope = new JSONObject().put("ok", false).put("error", message).toString();
        } catch (Exception e) {
            envelope = "{\"ok\":false,\"error\":\"Unknown error\"}";
        }
        deliver(callId, envelope);
    }

    private void deliver(int callId, String envelope) {
        final String js = "window.__dbiResolve(" + callId + "," + JSONObject.quote(envelope) + ")";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    private class Bridge {
        @JavascriptInterface
        public void invoke(final int callId, final String action, final String argsJson) {
            // Interrupt must bypass the worker queue, which is busy with the query it cancels.
            if ("interrupt".equals(action)) {
                engine.interrupt();
                resolve(callId, true);
                return;
            }
            worker.execute(() -> {
                try {
                    JSONObject args = argsJson == null || argsJson.isEmpty() ? new JSONObject() : new JSONObject(argsJson);
                    handle(callId, action, args);
                } catch (Throwable t) {
                    reject(callId, t);
                }
            });
        }
    }

    private void handle(int callId, String action, JSONObject args) throws Exception {
        String db = args.optString("db", "");
        switch (action) {
            case "context": resolve(callId, context()); break;
            case "listDatabases": resolve(callId, engine.listDatabases()); break;
            case "overview": resolve(callId, engine.overview(db)); break;
            case "tableSchema": resolve(callId, engine.tableSchema(db, args.getString("table"))); break;
            case "tableRows": resolve(callId, engine.tableRows(db, args)); break;
            case "cell": resolve(callId, engine.cell(db, args)); break;
            case "columnStats": resolve(callId, engine.columnStats(db, args)); break;
            case "query": resolve(callId, engine.query(db, args)); break;
            case "dbInfo": resolve(callId, engine.dbInfo(db)); break;
            case "tableSizes": resolve(callId, engine.tableSizes(db)); break;
            case "integrityCheck": resolve(callId, engine.integrityCheck(db)); break;
            case "storageGet": {
                SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
                resolve(callId, p.getString(args.getString("key"), null));
                break;
            }
            case "storageSet": {
                SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
                if (args.isNull("value")) e.remove(args.getString("key"));
                else e.putString(args.getString("key"), args.getString("value"));
                e.apply();
                resolve(callId, true);
                break;
            }
            case "saveFile": {
                String content = args.optString("content", "");
                byte[] bytes = args.optBoolean("base64", false)
                        ? Base64.decode(content, Base64.DEFAULT)
                        : content.getBytes(StandardCharsets.UTF_8);
                launchSave(callId, args.optString("name", "export.txt"), args.optString("mime", "text/plain"), bytes, null);
                break;
            }
            case "exportDatabase": {
                File snapshot = engine.snapshot(db);
                launchSave(callId, snapshot.getName(), "application/vnd.sqlite3", null, snapshot);
                break;
            }
            case "pickFile": launchPick(callId); break;
            case "setTheme": {
                final boolean dark = args.optBoolean("dark", false);
                final int color = Color.parseColor(args.optString("color", dark ? "#111827" : "#ffffff"));
                runOnUiThread(() -> applyTheme(dark, color));
                resolve(callId, true);
                break;
            }
            case "close": runOnUiThread(this::finish); resolve(callId, true); break;
            default: throw new IllegalArgumentException("Unknown action: " + action);
        }
    }

    private JSONObject context() throws Exception {
        PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
        String options = getIntent().getStringExtra(EXTRA_OPTIONS);
        return new JSONObject()
                .put("platform", "android")
                .put("osVersion", Build.VERSION.RELEASE)
                .put("device", Build.MANUFACTURER + " " + Build.MODEL)
                .put("appId", getPackageName())
                .put("appVersion", pi.versionName)
                .put("systemDark", isSystemDark())
                .put("options", options == null ? new JSONObject() : new JSONObject(options));
    }

    /**
     * The WebView's prefers-color-scheme follows this activity's (light) theme rather than the
     * system setting, so the page is told the real night mode explicitly.
     */
    private boolean isSystemDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (webView != null) webView.evaluateJavascript("window.__dbiSystemTheme && window.__dbiSystemTheme(" + isSystemDark() + ")", null);
    }

    private void applyTheme(boolean dark, int color) {
        root.setBackgroundColor(color);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            flags = dark ? flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            decor.setSystemUiVisibility(flags);
        }
        if (Build.VERSION.SDK_INT < 35) {
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
        }
    }

    // ---- Storage Access Framework (no storage permission needed) --------------------------

    private void launchSave(int callId, String name, String mime, byte[] bytes, File file) {
        runOnUiThread(() -> {
            pendingCallId = callId;
            pendingSaveBytes = bytes;
            pendingSaveFile = file;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime)
                    .putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(intent, REQUEST_SAVE);
        });
    }

    private void launchPick(int callId) {
        runOnUiThread(() -> {
            pendingCallId = callId;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "application/octet-stream"});
            startActivityForResult(intent, REQUEST_PICK);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_SAVE && requestCode != REQUEST_PICK) return;
        final int callId = pendingCallId;
        final byte[] bytes = pendingSaveBytes;
        final File file = pendingSaveFile;
        pendingCallId = -1;
        pendingSaveBytes = null;
        pendingSaveFile = null;
        if (callId < 0) return;

        final Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) {
            try {
                resolve(callId, new JSONObject().put("cancelled", true));
            } catch (Exception e) {
                reject(callId, e);
            }
            return;
        }
        worker.execute(() -> {
            try {
                if (requestCode == REQUEST_SAVE) {
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) throw new IllegalStateException("Cannot open destination");
                        if (file != null) {
                            try (InputStream in = new FileInputStream(file)) { DbInspectorEngine.copy(in, out); }
                            file.delete();
                        } else {
                            out.write(bytes);
                        }
                    }
                    resolve(callId, new JSONObject().put("saved", true));
                } else {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    try (InputStream in = getContentResolver().openInputStream(uri)) {
                        if (in == null) throw new IllegalStateException("Cannot open file");
                        byte[] chunk = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(chunk)) > 0) {
                            buf.write(chunk, 0, n);
                            if (buf.size() > MAX_IMPORT_BYTES) throw new IllegalStateException("File is larger than 10 MB");
                        }
                    }
                    String name = uri.getLastPathSegment();
                    resolve(callId, new JSONObject().put("name", name).put("text", new String(buf.toByteArray(), StandardCharsets.UTF_8)));
                }
            } catch (Throwable t) {
                reject(callId, t);
            }
        });
    }
}
