package dev.instafy.studio;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

@CapacitorPlugin(name = "InstafyAuthBridge")
public class InstafyAuthBridgePlugin extends Plugin {

    private static final String EVENT_URL_OPEN = "urlOpen";
    private static final String PREFS_NAME = "InstafyAuthBridge";
    private static final String PENDING_URL_KEY = "pendingUrl";
    private static final String LAST_CONSUMED_URL_KEY = "lastConsumedUrl";

    @Override
    public void load() {
        super.load();
        rememberPendingUrl(normalizeAuthIntentUrl(getActivity() != null ? getActivity().getIntent() : null));
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (getActivity() != null && intent != null) {
            getActivity().setIntent(intent);
        }
        rememberPendingUrl(normalizeAuthIntentUrl(intent));
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        rememberPendingUrl(normalizeAuthIntentUrl(getActivity() != null ? getActivity().getIntent() : null));
    }

    @PluginMethod
    public void consumePendingUrl(PluginCall call) {
        String pendingUrl = preferences().getString(PENDING_URL_KEY, null);
        if (pendingUrl == null || pendingUrl.trim().isEmpty()) {
            pendingUrl = normalizeAuthIntentUrl(getActivity() != null ? getActivity().getIntent() : null);
            String lastConsumedUrl = preferences().getString(LAST_CONSUMED_URL_KEY, null);
            if (pendingUrl != null && pendingUrl.equals(lastConsumedUrl)) {
                pendingUrl = null;
            }
        }

        JSObject payload = new JSObject();
        if (pendingUrl != null) {
            preferences().edit().putString(LAST_CONSUMED_URL_KEY, pendingUrl).remove(PENDING_URL_KEY).apply();
            payload.put("url", pendingUrl);
        }
        call.resolve(payload);
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private void rememberPendingUrl(@Nullable String url) {
        if (url == null || url.isEmpty()) {
            return;
        }
        String lastConsumedUrl = preferences().getString(LAST_CONSUMED_URL_KEY, null);
        if (url.equals(lastConsumedUrl)) {
            return;
        }
        preferences().edit().putString(PENDING_URL_KEY, url).apply();
        JSObject payload = new JSObject();
        payload.put("url", url);
        notifyListeners(EVENT_URL_OPEN, payload, true);
    }

    @Nullable
    private String normalizeAuthIntentUrl(@Nullable Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return null;
        }
        Uri data = intent.getData();
        if (data == null) {
            return null;
        }
        String value = data.toString();
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        String normalized = trimmed.toLowerCase(Locale.ROOT);
        if (!normalized.startsWith("instafy:") && !normalized.startsWith("dev.instafy.studio:")) {
            return null;
        }
        return trimmed;
    }
}
