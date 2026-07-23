package dev.instafy.studio;

import android.content.pm.ApplicationInfo;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Exposes native build policy that must be known before the web OTA bootstrap runs. */
@CapacitorPlugin(name = "InstafyRuntimeConfig")
public class InstafyRuntimeConfigPlugin extends Plugin {

    @PluginMethod
    public void getRuntimeConfig(PluginCall call) {
        boolean isDebuggable =
            (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        JSObject payload = new JSObject();
        payload.put("disableNativeOta", isDebuggable);
        call.resolve(payload);
    }
}
