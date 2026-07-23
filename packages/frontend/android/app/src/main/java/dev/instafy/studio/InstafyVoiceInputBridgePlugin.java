package dev.instafy.studio;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.ArrayList;
import java.util.Locale;

@CapacitorPlugin(
    name = "InstafyVoiceInputBridge",
    permissions = {
        @Permission(
            alias = "microphone",
            strings = {
                Manifest.permission.RECORD_AUDIO
            }
        )
    }
)
public class InstafyVoiceInputBridgePlugin extends Plugin implements RecognitionListener {

    private static final String EVENT_VOICE_INPUT = "voiceInput";

    private static final long DEFAULT_TEST_READY_DELAY_MS = 120L;
    private static final long DEFAULT_TEST_FINAL_DELAY_MS = 180L;

    private static final class TestSessionConfig {
        private final String transcript;
        @Nullable private final String partialTranscript;
        private final long readyDelayMs;
        private final long finalDelayMs;

        private TestSessionConfig(
            String transcript,
            @Nullable String partialTranscript,
            long readyDelayMs,
            long finalDelayMs
        ) {
            this.transcript = transcript;
            this.partialTranscript = partialTranscript;
            this.readyDelayMs = readyDelayMs;
            this.finalDelayMs = finalDelayMs;
        }
    }

    private final Handler mainThreadHandler = new Handler(Looper.getMainLooper());
    @Nullable private SpeechRecognizer speechRecognizer;
    @Nullable private TestSessionConfig testSessionConfig;
    @Nullable private Runnable pendingTestReadyRunnable;
    @Nullable private Runnable pendingTestFinalRunnable;
    private boolean listening = false;
    private boolean startPending = false;
    private boolean stopRequested = false;
    private boolean cancelRequested = false;
    @Nullable private String lastTranscript;

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        runOnMainThread(() -> cancelActiveRecognition(false));
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        runOnMainThread(this::destroySpeechRecognizer);
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        runOnMainThread(() -> {
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                publishError("Microphone permission was denied.");
                call.resolve();
                return;
            }
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                publishError("Voice input is unavailable on this device.");
                call.resolve();
                return;
            }
            if (listening || startPending) {
                call.resolve();
                return;
            }

            TestSessionConfig currentTestSession = testSessionConfig;
            if (currentTestSession != null) {
                startTestSession(call, currentTestSession);
                return;
            }

            try {
                ensureSpeechRecognizer();
                if (speechRecognizer == null) {
                    publishError("Voice input is unavailable on this device.");
                    call.resolve();
                    return;
                }
                startPending = true;
                stopRequested = false;
                cancelRequested = false;
                lastTranscript = null;
                speechRecognizer.startListening(buildRecognitionIntent());
                call.resolve();
            } catch (RuntimeException error) {
                resetState();
                publishError("Unable to start voice input: " + error.getMessage());
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        runOnMainThread(() -> {
            if (testSessionConfig != null) {
                stopTestSession();
                call.resolve();
                return;
            }
            stopRequested = true;
            cancelRequested = false;
            if (speechRecognizer != null && (listening || startPending)) {
                try {
                    speechRecognizer.stopListening();
                } catch (RuntimeException ignored) {
                    publishState(false);
                }
            } else {
                publishState(false);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        runOnMainThread(() -> {
            cancelActiveRecognition(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void configureTestSession(PluginCall call) {
        runOnMainThread(() -> {
            String rawTranscript = call.getString("transcript", "");
            String transcript = rawTranscript != null ? rawTranscript.trim() : "";
            if (transcript.isEmpty()) {
                call.reject("Voice input test transcript is required.");
                return;
            }

            String rawPartialTranscript = call.getString("partialTranscript");
            String partialTranscript =
                rawPartialTranscript != null && !rawPartialTranscript.trim().isEmpty()
                    ? rawPartialTranscript.trim()
                    : null;

            int readyDelayMs = Math.max(0, call.getInt("readyDelayMs", (int) DEFAULT_TEST_READY_DELAY_MS));
            int finalDelayMs = Math.max(0, call.getInt("finalDelayMs", (int) DEFAULT_TEST_FINAL_DELAY_MS));

            cancelPendingTestCallbacks();
            testSessionConfig =
                new TestSessionConfig(
                    transcript,
                    partialTranscript,
                    readyDelayMs,
                    finalDelayMs
                );

            JSObject payload = new JSObject();
            payload.put("configured", true);
            payload.put("transcript", transcript);
            call.resolve(payload);
        });
    }

    @PluginMethod
    public void clearTestSession(PluginCall call) {
        runOnMainThread(() -> {
            cancelPendingTestCallbacks();
            testSessionConfig = null;
            call.resolve();
        });
    }

    private void ensureSpeechRecognizer() {
        if (speechRecognizer != null) {
            return;
        }
        speechRecognizer =
            SpeechRecognizer.createSpeechRecognizer(getActivity() != null ? getActivity() : getContext());
        speechRecognizer.setRecognitionListener(this);
    }

    private Intent buildRecognitionIntent() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
        return intent;
    }

    private void cancelActiveRecognition(boolean clearTranscript) {
        cancelRequested = true;
        stopRequested = false;
        cancelPendingTestCallbacks();
        if (clearTranscript) {
            lastTranscript = null;
        }
        if (speechRecognizer != null) {
            try {
                speechRecognizer.cancel();
            } catch (RuntimeException ignored) {
                // Ignore shutdown races from the platform speech stack.
            }
        }
        resetState();
        publishState(false);
        if (clearTranscript) {
            publishTranscript("", false);
        }
    }

    private void destroySpeechRecognizer() {
        cancelPendingTestCallbacks();
        if (speechRecognizer != null) {
            try {
                speechRecognizer.destroy();
            } catch (RuntimeException ignored) {
                // Ignore teardown races.
            }
            speechRecognizer = null;
        }
        resetState();
    }

    private void startTestSession(PluginCall call, TestSessionConfig config) {
        cancelPendingTestCallbacks();
        startPending = true;
        stopRequested = false;
        cancelRequested = false;
        listening = false;
        lastTranscript = null;

        pendingTestReadyRunnable =
            () -> {
                pendingTestReadyRunnable = null;
                if (cancelRequested) {
                    return;
                }
                startPending = false;
                listening = true;
                publishState(true);
                if (config.partialTranscript != null) {
                    lastTranscript = config.partialTranscript;
                    publishTranscript(config.partialTranscript, true);
                }
            };

        mainThreadHandler.postDelayed(pendingTestReadyRunnable, config.readyDelayMs);
        call.resolve();
    }

    private void stopTestSession() {
        TestSessionConfig config = testSessionConfig;
        if (config == null) {
            publishState(false);
            return;
        }

        stopRequested = true;
        cancelRequested = false;

        if (!startPending && !listening) {
            publishState(false);
            return;
        }

        if (pendingTestReadyRunnable != null) {
            mainThreadHandler.removeCallbacks(pendingTestReadyRunnable);
            pendingTestReadyRunnable = null;
        }

        startPending = false;
        listening = false;

        pendingTestFinalRunnable =
            () -> {
                pendingTestFinalRunnable = null;
                if (cancelRequested) {
                    return;
                }
                String transcript = config.transcript;
                lastTranscript = transcript;
                resetState();
                publishTranscript(transcript, false);
            };

        mainThreadHandler.postDelayed(pendingTestFinalRunnable, config.finalDelayMs);
    }

    private void cancelPendingTestCallbacks() {
        if (pendingTestReadyRunnable != null) {
            mainThreadHandler.removeCallbacks(pendingTestReadyRunnable);
            pendingTestReadyRunnable = null;
        }
        if (pendingTestFinalRunnable != null) {
            mainThreadHandler.removeCallbacks(pendingTestFinalRunnable);
            pendingTestFinalRunnable = null;
        }
    }

    private void runOnMainThread(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
            return;
        }
        mainThreadHandler.post(action);
    }

    private void resetState() {
        listening = false;
        startPending = false;
        stopRequested = false;
        cancelRequested = false;
    }

    private void publishState(boolean nextListening) {
        JSObject payload = new JSObject();
        payload.put("type", "state");
        payload.put("listening", nextListening);
        notifyListeners(EVENT_VOICE_INPUT, payload, true);
    }

    private void publishTranscript(@Nullable String transcript, boolean nextListening) {
        JSObject payload = new JSObject();
        payload.put("type", "transcript");
        payload.put("transcript", transcript != null ? transcript : "");
        payload.put("listening", nextListening);
        notifyListeners(EVENT_VOICE_INPUT, payload, true);
    }

    private void publishError(String message) {
        JSObject payload = new JSObject();
        payload.put("type", "error");
        payload.put("message", message);
        notifyListeners(EVENT_VOICE_INPUT, payload, true);
    }

    @Nullable
    private String extractTranscript(@Nullable Bundle results) {
        if (results == null) {
            return null;
        }
        ArrayList<String> transcripts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (transcripts == null || transcripts.isEmpty()) {
            return null;
        }
        String transcript = transcripts.get(0);
        if (transcript == null) {
            return null;
        }
        String trimmed = transcript.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private String describeError(int errorCode) {
        switch (errorCode) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "Voice input could not access your microphone.";
            case SpeechRecognizer.ERROR_CLIENT:
                return "Voice input was interrupted. Try holding to talk again.";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "Microphone permission was denied.";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "Voice input needs an internet connection or on-device speech support.";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "No speech detected";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "Voice input is resetting. Try again in a moment.";
            case SpeechRecognizer.ERROR_SERVER:
                return "Voice input service is unavailable.";
            default:
                return "Voice input failed.";
        }
    }

    @Override
    public void onReadyForSpeech(Bundle params) {
        startPending = false;
        listening = true;
        publishState(true);
    }

    @Override
    public void onBeginningOfSpeech() {
        startPending = false;
        listening = true;
        publishState(true);
    }

    @Override
    public void onRmsChanged(float rmsdB) {
        // No-op.
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
        // No-op.
    }

    @Override
    public void onEndOfSpeech() {
        listening = false;
        startPending = false;
    }

    @Override
    public void onError(int error) {
        if (cancelRequested) {
            resetState();
            publishState(false);
            return;
        }
        if (stopRequested && (error == SpeechRecognizer.ERROR_CLIENT || error == SpeechRecognizer.ERROR_NO_MATCH)) {
            String transcript = lastTranscript != null ? lastTranscript : "";
            resetState();
            publishTranscript(transcript, false);
            return;
        }
        resetState();
        publishError(describeError(error));
    }

    @Override
    public void onResults(Bundle results) {
        String transcript = extractTranscript(results);
        if (transcript != null) {
            lastTranscript = transcript;
        }
        resetState();
        publishTranscript(lastTranscript != null ? lastTranscript : "", false);
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        String transcript = extractTranscript(partialResults);
        if (transcript == null) {
            return;
        }
        lastTranscript = transcript;
        publishTranscript(transcript, true);
    }

    @Override
    public void onEvent(int eventType, Bundle params) {
        // No-op.
    }
}
