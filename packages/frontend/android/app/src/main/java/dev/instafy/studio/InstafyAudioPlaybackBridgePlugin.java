package dev.instafy.studio;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.util.Base64;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

@CapacitorPlugin(name = "InstafyAudioPlaybackBridge")
public class InstafyAudioPlaybackBridgePlugin extends Plugin {

    @Nullable private MediaPlayer mediaPlayer;
    @Nullable private File lastTempAudioFile;
    @Nullable private AudioManager audioManager;
    @Nullable private AudioFocusRequest audioFocusRequest;
    private boolean audioFocusHeld = false;

    private final AudioManager.OnAudioFocusChangeListener audioFocusChangeListener =
        focusChange -> {
            if (
                focusChange == AudioManager.AUDIOFOCUS_LOSS ||
                focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
            ) {
                stopPlayback();
            }
        };

    @Override
    public void load() {
        super.load();
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        stopPlayback();
    }

    @PluginMethod
    public void play(PluginCall call) {
        String audioUrl = trim(call.getString("audioUrl"));
        String audioDataUrl = trim(call.getString("audioDataUrl"));
        if (audioDataUrl == null && audioUrl == null) {
            call.reject("Native audio playback requires audioUrl or audioDataUrl.");
            return;
        }

        stopPlayback();
        requestAudioFocus();

        final MediaPlayer player = new MediaPlayer();
        final boolean[] settled = {false};
        @Nullable File tempAudioFile = null;
        try {
            player.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            );

            if (audioDataUrl != null) {
                tempAudioFile = writeTempAudioFile(audioDataUrl);
                player.setDataSource(tempAudioFile.getAbsolutePath());
            } else if (isNetworkAudioUrl(audioUrl)) {
                tempAudioFile = downloadTempAudioFile(audioUrl);
                player.setDataSource(tempAudioFile.getAbsolutePath());
            } else {
                player.setDataSource(audioUrl);
            }

            final File resolvedTempAudioFile = tempAudioFile;
            player.setOnCompletionListener(
                completedPlayer -> {
                    releasePlayer(false);
                    abandonAudioFocus();
                }
            );
            player.setOnErrorListener(
                (failedPlayer, what, extra) -> {
                    releasePlayer(false);
                    abandonAudioFocus();
                    if (!settled[0]) {
                        settled[0] = true;
                        call.reject(
                            String.format(Locale.US, "Native audio playback failed (what=%d, extra=%d).", what, extra)
                        );
                    }
                    return true;
                }
            );
            player.prepare();
            mediaPlayer = player;
            lastTempAudioFile = resolvedTempAudioFile;
            player.start();
            if (!settled[0]) {
                settled[0] = true;
                JSObject payload = new JSObject();
                payload.put("ok", true);
                call.resolve(payload);
            }
        } catch (Exception error) {
            if (tempAudioFile != null) {
                deleteQuietly(tempAudioFile);
            }
            player.release();
            abandonAudioFocus();
            call.reject(error.getMessage());
        }
    }

    private void stopPlayback() {
        releasePlayer(true);
        abandonAudioFocus();
    }

    private void releasePlayer(boolean stopFirst) {
        if (mediaPlayer != null) {
            try {
                if (stopFirst) {
                    mediaPlayer.stop();
                }
            } catch (IllegalStateException ignored) {
                // Ignore invalid player state during teardown.
            }
            mediaPlayer.reset();
            mediaPlayer.release();
            mediaPlayer = null;
        }
        if (lastTempAudioFile != null) {
            deleteQuietly(lastTempAudioFile);
            lastTempAudioFile = null;
        }
    }

    private void requestAudioFocus() {
        if (audioManager == null) {
            return;
        }

        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                audioFocusRequest =
                    new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(
                            new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build()
                        )
                        .setAcceptsDelayedFocusGain(false)
                        .setOnAudioFocusChangeListener(audioFocusChangeListener)
                        .build();
            }
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result =
                audioManager.requestAudioFocus(
                    audioFocusChangeListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
                );
        }
        audioFocusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonAudioFocus() {
        if (audioManager == null || !audioFocusHeld) {
            audioFocusHeld = false;
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        } else {
            audioManager.abandonAudioFocus(audioFocusChangeListener);
        }
        audioFocusHeld = false;
    }

    private static File writeTempAudioFile(String audioDataUrl) throws IOException {
        DecodedAudioData decoded = decodeAudioDataUrl(audioDataUrl);
        File tempFile = File.createTempFile("instafy-reply-", decoded.extension);
        try (FileOutputStream outputStream = new FileOutputStream(tempFile)) {
            outputStream.write(decoded.bytes);
            outputStream.flush();
        }
        return tempFile;
    }

    private static File downloadTempAudioFile(String audioUrl) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(audioUrl).openConnection();
            connection.setUseCaches(false);
            connection.setDoInput(true);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.connect();
            int statusCode = connection.getResponseCode();
            if (statusCode < 200 || statusCode >= 300) {
                throw new IOException(
                    String.format(Locale.US, "Native audio download failed (%d).", statusCode)
                );
            }

            String mimeType = trim(connection.getContentType());
            File tempFile = File.createTempFile("instafy-reply-", extensionForMimeType(mimeType));
            try (
                InputStream inputStream = connection.getInputStream();
                OutputStream outputStream = new FileOutputStream(tempFile)
            ) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = inputStream.read(buffer)) != -1) {
                    outputStream.write(buffer, 0, read);
                }
                outputStream.flush();
            }
            return tempFile;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static boolean isNetworkAudioUrl(@Nullable String audioUrl) {
        if (audioUrl == null) {
            return false;
        }
        String normalized = audioUrl.trim().toLowerCase(Locale.US);
        return normalized.startsWith("http://") || normalized.startsWith("https://");
    }

    private static DecodedAudioData decodeAudioDataUrl(String audioDataUrl) {
        int commaIndex = audioDataUrl.indexOf(',');
        if (commaIndex <= 0 || !audioDataUrl.startsWith("data:")) {
            throw new IllegalArgumentException("Unsupported audioDataUrl payload.");
        }

        String metadata = audioDataUrl.substring(5, commaIndex);
        String data = audioDataUrl.substring(commaIndex + 1);
        boolean base64Encoded = metadata.contains(";base64");
        String mimeType = metadata.replace(";base64", "").trim();
        if (!base64Encoded) {
            throw new IllegalArgumentException("Native audio playback expects a base64 audioDataUrl payload.");
        }

        return new DecodedAudioData(Base64.decode(data, Base64.DEFAULT), extensionForMimeType(mimeType));
    }

    private static String extensionForMimeType(String mimeType) {
        String normalized = mimeType == null ? "" : mimeType.trim().toLowerCase(Locale.US);
        if (normalized.contains("wav")) {
            return ".wav";
        }
        if (normalized.contains("mpeg") || normalized.contains("mp3")) {
            return ".mp3";
        }
        if (normalized.contains("ogg")) {
            return ".ogg";
        }
        if (normalized.contains("aac")) {
            return ".aac";
        }
        if (normalized.contains("m4a") || normalized.contains("mp4")) {
            return ".m4a";
        }
        return ".bin";
    }

    @Nullable
    private static String trim(@Nullable String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static void deleteQuietly(@Nullable File file) {
        if (file == null) {
            return;
        }
        try {
            if (file.exists()) {
                file.delete();
            }
        } catch (SecurityException ignored) {
            // Ignore temp-file cleanup failures.
        }
    }

    private static final class DecodedAudioData {
        final byte[] bytes;
        final String extension;

        DecodedAudioData(byte[] bytes, String extension) {
            this.bytes = bytes;
            this.extension = extension;
        }
    }
}
