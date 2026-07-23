package dev.instafy.studio;

import android.Manifest;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.Locale;

@CapacitorPlugin(
    name = "InstafyAudioSessionBridge",
    permissions = {
        @Permission(
            alias = "microphone",
            strings = {
                Manifest.permission.RECORD_AUDIO
            }
        )
    }
)
public class InstafyAudioSessionBridgePlugin extends Plugin {

    private static final String EVENT_AUDIO_SESSION = "audioSession";
    private static final String APP_STATE_ACTIVE = "active";
    private static final String APP_STATE_INACTIVE = "inactive";
    private static final String APP_STATE_BACKGROUND = "background";
    private static final String APP_STATE_UNKNOWN = "unknown";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    @Nullable private AudioManager audioManager;
    @Nullable private AudioFocusRequest audioFocusRequest;
    private boolean audioFocusHeld = false;
    private boolean voiceCaptureActive = false;
    private boolean interrupted = false;
    @Nullable private String interruptionReason;
    @Nullable private String lastRouteChangeReason;
    private String appState = APP_STATE_UNKNOWN;

    private final AudioManager.OnAudioFocusChangeListener audioFocusChangeListener =
        focusChange -> handleAudioFocusChange(focusChange);

    private final AudioDeviceCallback audioDeviceCallback =
        new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                lastRouteChangeReason = "audio devices added";
                publishStatus("devices_added");
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                lastRouteChangeReason = "audio devices removed";
                publishStatus("devices_removed");
            }
        };

    @Override
    public void load() {
        super.load();
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        appState = getActivity() != null ? APP_STATE_ACTIVE : APP_STATE_UNKNOWN;
        registerAudioDeviceMonitoring();
        publishStatus("load");
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        appState = APP_STATE_ACTIVE;
        publishStatus("resume");
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        appState = APP_STATE_INACTIVE;
        publishStatus("pause");
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        appState = APP_STATE_BACKGROUND;
        publishStatus("stop");
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        unregisterAudioDeviceMonitoring();
        abandonAudioFocus();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatusPayload("refresh"));
    }

    @PluginMethod
    public void requestMicrophonePermissions(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(buildStatusPayload("microphone_permission_granted"));
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionsCallback");
    }

    @PermissionCallback
    private void microphonePermissionsCallback(PluginCall call) {
        publishStatus("microphone_permission");
        call.resolve(buildStatusPayload("microphone_permission"));
    }

    @PluginMethod
    public void setVoiceCaptureActive(PluginCall call) {
        boolean nextActive = call.getBoolean("active", false);
        voiceCaptureActive = nextActive;

        if (nextActive) {
            // Android speech recognition manages its own audio focus internally. Requesting
            // focus here causes a transient self-interruption when the recognizer starts,
            // which then cancels the active voice turn in the JS recovery layer.
            audioFocusHeld = false;
            interrupted = false;
            interruptionReason = null;
        } else {
            interrupted = false;
            interruptionReason = null;
            abandonAudioFocus();
        }

        publishStatus(nextActive ? "voice_capture_started" : "voice_capture_ended");
        call.resolve(buildStatusPayload(nextActive ? "voice_capture_started" : "voice_capture_ended"));
    }

    private void registerAudioDeviceMonitoring() {
        if (audioManager == null) {
            return;
        }
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, mainHandler);
    }

    private void unregisterAudioDeviceMonitoring() {
        if (audioManager == null) {
            return;
        }
        audioManager.unregisterAudioDeviceCallback(audioDeviceCallback);
    }

    private boolean requestAudioFocus() {
        if (audioManager == null) {
            return false;
        }

        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                audioFocusRequest =
                    new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                        .setAudioAttributes(
                            new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build()
                        )
                        .setWillPauseWhenDucked(true)
                        .setAcceptsDelayedFocusGain(false)
                        .setOnAudioFocusChangeListener(audioFocusChangeListener, mainHandler)
                        .build();
            }
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result =
                audioManager.requestAudioFocus(
                    audioFocusChangeListener,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                );
        }
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
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

    private void handleAudioFocusChange(int focusChange) {
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_GAIN:
                audioFocusHeld = true;
                interrupted = false;
                interruptionReason = null;
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                audioFocusHeld = false;
                interrupted = true;
                interruptionReason = "audio focus lost temporarily";
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                audioFocusHeld = false;
                interrupted = true;
                interruptionReason = "audio focus changed and may duck";
                break;
            case AudioManager.AUDIOFOCUS_LOSS:
                audioFocusHeld = false;
                interrupted = true;
                interruptionReason = "audio focus lost";
                break;
            default:
                break;
        }
        publishStatus("audio_focus_change");
    }

    private JSObject buildStatusPayload(String reason) {
        JSObject payload = new JSObject();
        payload.put("snapshot", buildSnapshot(reason));
        return payload;
    }

    private void publishStatus(String reason) {
        JSObject payload = buildStatusPayload(reason);
        notifyListeners(EVENT_AUDIO_SESSION, payload, true);
    }

    private JSObject buildSnapshot(String reason) {
        JSObject snapshot = new JSObject();
        snapshot.put("platform", "android");
        snapshot.put("appState", appState);
        snapshot.put("microphonePermission", describeMicrophonePermission());
        snapshot.put("audioSessionActive", audioFocusHeld || voiceCaptureActive);
        snapshot.put("voiceCaptureActive", voiceCaptureActive);
        snapshot.put("interrupted", interrupted);
        snapshot.put("interruptionReason", interruptionReason);
        snapshot.put("routeChangeReason", lastRouteChangeReason);

        JSArray inputLabels = new JSArray();
        JSArray outputLabels = new JSArray();
        JSArray bluetoothLikeOutputLabels = new JSArray();

        AudioDeviceInfo preferredOutput = getPreferredOutputDevice();
        String preferredOutputLabel = null;
        String routeKind = "unknown";

        if (audioManager != null) {
            AudioDeviceInfo[] inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            for (AudioDeviceInfo device : inputs) {
                String label = getDeviceLabel(device);
                if (label != null) {
                    inputLabels.put(label);
                }
            }

            AudioDeviceInfo[] outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            for (AudioDeviceInfo device : outputs) {
                String label = getDeviceLabel(device);
                if (label == null) {
                    continue;
                }
                outputLabels.put(label);
                if (isBluetoothLikeDevice(device, label)) {
                    bluetoothLikeOutputLabels.put(label);
                }
            }

            if (preferredOutput != null) {
                preferredOutputLabel = getDeviceLabel(preferredOutput);
                routeKind = classifyRouteKind(preferredOutput, preferredOutputLabel);
            } else if (outputLabels.length() > 0) {
                preferredOutputLabel = outputLabels.optString(0, null);
                routeKind = classifyRouteKind(null, preferredOutputLabel);
            }
        }

        snapshot.put("inputLabels", inputLabels);
        snapshot.put("outputLabels", outputLabels);
        snapshot.put("preferredOutputLabel", preferredOutputLabel);
        snapshot.put("bluetoothLikeOutputLabels", bluetoothLikeOutputLabels);
        snapshot.put("routeKind", routeKind);
        snapshot.put("reason", reason);
        snapshot.put("updatedAt", String.valueOf(System.currentTimeMillis()));
        return snapshot;
    }

    @Nullable
    private AudioDeviceInfo getPreferredOutputDevice() {
        if (audioManager == null) {
            return null;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo communicationDevice = audioManager.getCommunicationDevice();
            if (communicationDevice != null) {
                return communicationDevice;
            }
        }
        AudioDeviceInfo[] outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        AudioDeviceInfo bluetoothDevice = null;
        AudioDeviceInfo speakerDevice = null;
        AudioDeviceInfo fallbackDevice = null;
        for (AudioDeviceInfo device : outputs) {
            if (fallbackDevice == null) {
                fallbackDevice = device;
            }
            String label = getDeviceLabel(device);
            if (bluetoothDevice == null && isBluetoothLikeDevice(device, label)) {
                bluetoothDevice = device;
            }
            if (speakerDevice == null && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                speakerDevice = device;
            }
        }
        if (bluetoothDevice != null) {
            return bluetoothDevice;
        }
        if (audioManager.isSpeakerphoneOn() && speakerDevice != null) {
            return speakerDevice;
        }
        return fallbackDevice;
    }

    private String describeMicrophonePermission() {
        PermissionState permissionState = getPermissionState("microphone");
        if (permissionState == PermissionState.GRANTED) {
            return "granted";
        }
        if (permissionState == PermissionState.DENIED) {
            return "denied";
        }
        return "prompt";
    }

    @Nullable
    private String getDeviceLabel(@Nullable AudioDeviceInfo device) {
        if (device == null) {
            return null;
        }
        CharSequence productName = device.getProductName();
        if (productName == null) {
            return null;
        }
        String value = productName.toString().trim();
        return value.isEmpty() ? null : value;
    }

    private boolean isBluetoothLikeDevice(@Nullable AudioDeviceInfo device, @Nullable String label) {
        if (device != null) {
            switch (device.getType()) {
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                    return true;
                default:
                    break;
            }
        }
        return isBluetoothLikeLabel(label);
    }

    private boolean isBluetoothLikeLabel(@Nullable String label) {
        if (label == null) {
            return false;
        }
        String normalized = label.trim().toLowerCase(Locale.ROOT);
        return normalized.contains("airpods")
            || normalized.contains("beats")
            || normalized.contains("bluetooth")
            || normalized.contains("headset")
            || normalized.contains("headphone")
            || normalized.contains("earbud")
            || normalized.contains("hands-free")
            || normalized.contains("pods");
    }

    private String classifyRouteKind(@Nullable AudioDeviceInfo device, @Nullable String label) {
        if (isBluetoothLikeDevice(device, label)) {
            return "bluetooth";
        }
        if (device != null) {
            switch (device.getType()) {
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                    return "speaker";
                case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                    return "receiver";
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_USB_DEVICE:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                case AudioDeviceInfo.TYPE_DOCK:
                case AudioDeviceInfo.TYPE_HDMI:
                case AudioDeviceInfo.TYPE_HDMI_ARC:
                case AudioDeviceInfo.TYPE_LINE_ANALOG:
                case AudioDeviceInfo.TYPE_LINE_DIGITAL:
                    return "wired_or_builtin";
                default:
                    break;
            }
        }
        if (audioManager != null && audioManager.isSpeakerphoneOn()) {
            return "speaker";
        }
        return label != null ? "wired_or_builtin" : "unknown";
    }
}
