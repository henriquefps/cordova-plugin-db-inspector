var exec = require('cordova/exec');

function promisify(action, args, success, error) {
    return new Promise(function (resolve, reject) {
        exec(function (result) {
            if (success) success(result);
            resolve(result);
        }, function (err) {
            if (error) error(err);
            reject(err);
        }, 'DbInspector', action, args);
    });
}

module.exports = {
    /**
     * Opens the full-screen, read-only database inspector.
     *
     * options (all optional):
     *   database: string     - file name (or id) of the database to select first
     *   presets:  Array|obj  - query presets to merge into the saved ones (same JSON format
     *                          the inspector exports), e.g. team-wide queries shipped with the app
     *   title:    string     - header title (default "DB Inspector")
     */
    open: function (options, success, error) {
        if (typeof options === 'function') {
            error = success;
            success = options;
            options = {};
        }
        return promisify('open', [options || {}], success, error);
    },

    /** Lists the SQLite files found in the app sandbox (no UI). */
    listDatabases: function (success, error) {
        return promisify('listDatabases', [], success, error);
    }
};
