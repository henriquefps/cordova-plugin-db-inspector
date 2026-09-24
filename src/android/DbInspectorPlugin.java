package com.hfps.dbinspector;

import android.content.Intent;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

public class DbInspectorPlugin extends CordovaPlugin {

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) {
        switch (action) {
            case "open": {
                JSONObject options = args.optJSONObject(0);
                Intent intent = new Intent(cordova.getActivity(), DbInspectorActivity.class);
                intent.putExtra(DbInspectorActivity.EXTRA_OPTIONS, options == null ? "{}" : options.toString());
                cordova.getActivity().startActivity(intent);
                callbackContext.success();
                return true;
            }
            case "listDatabases": {
                cordova.getThreadPool().execute(() -> {
                    try {
                        callbackContext.success(new DbInspectorEngine(cordova.getContext()).listDatabases());
                    } catch (Exception e) {
                        callbackContext.error(e.getMessage());
                    }
                });
                return true;
            }
            default:
                return false;
        }
    }
}
