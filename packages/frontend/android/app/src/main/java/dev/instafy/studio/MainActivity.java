package dev.instafy.studio;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(InstafyRuntimeConfigPlugin.class);
        registerPlugin(InstafyAuthBridgePlugin.class);
        registerPlugin(InstafyAudioSessionBridgePlugin.class);
        registerPlugin(InstafyAudioPlaybackBridgePlugin.class);
        registerPlugin(InstafyVoiceInputBridgePlugin.class);
        registerPlugin(InstafyCameraExtensionPlugin.class);
        registerPlugin(InstafyLanDiscoveryBridgePlugin.class);
        registerPlugin(InstafySpeechHttpBridgePlugin.class);
        super.onCreate(savedInstanceState);
        boolean isDebuggable =
            (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (isDebuggable && getBridge() != null && getBridge().getWebView() != null) {
            // Local mobile smoke runs still target HTTP Supabase/controller endpoints.
            // Capacitor serves the app from https://localhost, so debug builds must
            // explicitly allow mixed content or Android blocks auth as mixed-content.
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        if (intent != null) {
            setIntent(intent);
        }
        super.onNewIntent(intent);
    }
}
