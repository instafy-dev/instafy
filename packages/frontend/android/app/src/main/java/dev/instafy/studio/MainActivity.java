package dev.instafy.studio;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import org.json.JSONException;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    /**
     * The dark status bar ThemeProvider applies at runtime
     * (NATIVE_STATUS_BAR_BACKGROUND.dark). capacitor.config.ts carries the
     * light pair, which the StatusBar plugin applies natively when the bridge
     * loads, long before JavaScript runs.
     */
    private static final String DARK_STATUS_BAR_BACKGROUND = "#181818";

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
        useNightStartupStatusBar();
        super.onCreate(savedInstanceState);
        paintWebViewWithLaunchCanvas();
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
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // uiMode is a handled config change, so the activity is not recreated.
        paintWebViewWithLaunchCanvas();
    }

    /**
     * Under a night system theme the launch window is the dark canvas, but the
     * StatusBar plugin would repaint the bar white from the static config
     * (Android before 15) until ThemeProvider syncs it. Hand the plugin the dark
     * pair instead; a light system theme keeps the static config untouched.
     */
    private void useNightStartupStatusBar() {
        int nightMode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        if (nightMode != Configuration.UI_MODE_NIGHT_YES) {
            return;
        }
        CapConfig capConfig = CapConfig.loadDefault(this);
        JSONObject statusBar = capConfig.getPluginConfiguration("StatusBar").getConfigJSON();
        try {
            statusBar.put("backgroundColor", DARK_STATUS_BAR_BACKGROUND);
            statusBar.put("style", "DARK");
        } catch (JSONException ignored) {
            return;
        }
        config = capConfig;
    }

    /**
     * Until the page paints, the WebView shows its own background, white by
     * default, and on Android 15+ that is also what sits under the transparent
     * status bar. Use the launch canvas (splash_background: brand paper, or the
     * dark canvas under night) so the launch screen hands over without a flash.
     */
    private void paintWebViewWithLaunchCanvas() {
        if (getBridge() == null) {
            return;
        }
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setBackgroundColor(getColor(R.color.splash_background));
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
