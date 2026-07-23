package dev.instafy.studio;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

@CapacitorPlugin(name = "InstafySpeechHttpBridge")
public class InstafySpeechHttpBridgePlugin extends Plugin {
    @PluginMethod
    public void health(PluginCall call) {
        performRequest(call, "GET", false);
    }

    @PluginMethod
    public void transcribe(PluginCall call) {
        performRequest(call, "POST", false);
    }

    @PluginMethod
    public void synthesize(PluginCall call) {
        performRequest(call, "POST", true);
    }

    private void performRequest(PluginCall call, String method, boolean expectsAudio) {
        String urlValue = normalize(call.getString("url"));
        if (urlValue == null) {
            call.reject("Speech bridge requires a valid request url.");
            return;
        }
        String authToken = normalize(call.getString("authToken"));

        final String requestUrl = urlValue;
        final String requestMethod = method;
        final String requestBodyJson;
        if ("GET".equals(requestMethod)) {
            requestBodyJson = null;
        } else {
            String bodyJson = call.getString("bodyJson");
            requestBodyJson = bodyJson != null ? bodyJson : "{}";
        }
        final String requestAuthToken = authToken;
        new Thread(
                () -> {
                    HttpURLConnection connection = null;
                    try {
                        connection = (HttpURLConnection) new URL(requestUrl).openConnection();
                        connection.setRequestMethod(requestMethod);
                        connection.setDoOutput(!"GET".equals(requestMethod));
                        connection.setDoInput(true);
                        connection.setUseCaches(false);
                        connection.setConnectTimeout(15000);
                        connection.setReadTimeout(30000);
                        if (!"GET".equals(requestMethod)) {
                            connection.setRequestProperty("Content-Type", "application/json");
                        }
                        if (requestAuthToken != null) {
                            connection.setRequestProperty(
                                    "Authorization", String.format(Locale.ROOT, "Bearer %s", requestAuthToken));
                        }

                        if (!"GET".equals(requestMethod) && requestBodyJson != null) {
                            try (OutputStream output = connection.getOutputStream()) {
                                output.write(requestBodyJson.getBytes(StandardCharsets.UTF_8));
                            }
                        }

                        int statusCode = connection.getResponseCode();
                        String contentType = normalize(connection.getHeaderField("Content-Type"));
                        byte[] responseBytes = readAllBytes(
                                statusCode >= 200 && statusCode < 300 ? connection.getInputStream() : connection.getErrorStream());

                        if (statusCode < 200 || statusCode >= 300) {
                            String detail = new String(responseBytes, StandardCharsets.UTF_8).trim();
                            String suffix = detail.isEmpty() ? "" : ": " + detail;
                            call.reject("Speech bridge request failed (" + statusCode + ")" + suffix);
                            return;
                        }

                        JSObject payload = new JSObject();
                        payload.put("statusCode", statusCode);
                        if (contentType != null) {
                            payload.put("contentType", contentType);
                        }

                        if (expectsAudio && contentType != null && contentType.startsWith("audio/")) {
                            payload.put("mimeType", contentType);
                            payload.put(
                                    "audioDataUrl",
                                    "data:"
                                            + contentType
                                            + ";base64,"
                                            + Base64.encodeToString(responseBytes, Base64.NO_WRAP));
                            call.resolve(payload);
                            return;
                        }

                        String responseText = new String(responseBytes, StandardCharsets.UTF_8).trim();
                        if (contentType != null && contentType.contains("application/json") && !responseText.isEmpty()) {
                            payload.put("payloadJson", responseText);
                        } else if (!responseText.isEmpty()) {
                            payload.put("text", responseText);
                        }
                        call.resolve(payload);
                    } catch (Exception error) {
                        call.reject(error.getMessage() != null ? error.getMessage() : "Speech bridge request failed.");
                    } finally {
                        if (connection != null) {
                            connection.disconnect();
                        }
                    }
                })
            .start();
    }

    private byte[] readAllBytes(InputStream stream) throws Exception {
        if (stream == null) {
            return new byte[0];
        }
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private String normalize(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
