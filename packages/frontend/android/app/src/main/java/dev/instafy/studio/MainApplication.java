package dev.instafy.studio;

import android.app.Application;
import android.content.pm.ApplicationInfo;
import android.util.Log;

import java.io.File;

public class MainApplication extends Application {
    private static final String TAG = "MainApplication";

    @Override
    public void onCreate() {
        super.onCreate();
        resetDebugLiveUpdateState();
    }

    private void resetDebugLiveUpdateState() {
        boolean isDebuggable =
            (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!isDebuggable) {
            return;
        }

        try {
            deleteSharedPreferences("CapWebViewSettings");
            deleteSharedPreferences("CapawesomeLiveUpdate");
        } catch (Exception error) {
            Log.w(TAG, "Unable to clear live update shared preferences in debug.", error);
        }

        try {
            File liveUpdateBundlesDir = new File(getFilesDir(), "_capacitor_live_update_bundles");
            deleteRecursively(liveUpdateBundlesDir);
        } catch (Exception error) {
            Log.w(TAG, "Unable to clear live update bundles in debug.", error);
        }
    }

    private static void deleteRecursively(File target) {
        if (target == null || !target.exists()) {
            return;
        }

        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }

        if (!target.delete() && target.exists()) {
            throw new IllegalStateException("Unable to delete " + target.getAbsolutePath());
        }
    }
}
