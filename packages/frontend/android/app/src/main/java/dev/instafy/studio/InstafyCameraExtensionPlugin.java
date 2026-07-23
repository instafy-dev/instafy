package dev.instafy.studio;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.BitmapFactory;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.net.Uri;
import android.provider.Settings;
import android.os.Build;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "InstafyCameraExtension",
    permissions = {
        @Permission(
            alias = "camera",
            strings = {
                Manifest.permission.CAMERA
            }
        )
    }
)
public class InstafyCameraExtensionPlugin extends Plugin {
    private static final String TAG = "InstafyCameraExtension";

    private static final String CAPTURE_CACHE_DIR = "instafy-camera";

    @Nullable private File pendingCaptureFile;
    @Nullable private Uri pendingCaptureUri;
    @Nullable private String pendingLensId;
    @Nullable private JSObject lastCapturePayload;
    private String selectedLensId = "rear";

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatusPayload(null));
    }

    @PluginMethod
    public void requestCameraPermissions(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            call.resolve(buildStatusPayload(null));
            return;
        }
        requestPermissionForAlias("camera", call, "cameraPermissionCallback");
    }

    @PluginMethod
    public void openCameraSettings(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Camera settings are unavailable because the current activity is missing.");
            return;
        }

        Intent intent = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", activity.getPackageName(), null)
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
        call.resolve(buildStatusPayload(null));
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        call.resolve(buildStatusPayload(null));
    }

    @PluginMethod
    public void capturePhoto(PluginCall call) {
        if (pendingCaptureFile != null) {
            call.reject("A camera capture is already in progress.");
            return;
        }
        if (!hasCameraHardware()) {
            call.reject("This device does not report an available camera.");
            return;
        }
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission is not granted yet.");
            return;
        }
        if (getActivity() == null) {
            call.reject("Camera capture is unavailable because the current activity is missing.");
            return;
        }

        String lensId = normalizeLensId(call.getString("lens"));
        File outputFile;
        try {
            outputFile = createOutputFile(lensId);
        } catch (IOException error) {
            call.reject(error.getMessage());
            return;
        }
        Log.d(TAG, "Launching in-app camera capture for lens=" + lensId + " output=" + outputFile.getAbsolutePath());

        Uri outputUri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            outputFile
        );

        Intent intent = new Intent(getActivity(), InstafyCameraCaptureActivity.class);
        intent.putExtra(InstafyCameraCaptureActivity.EXTRA_OUTPUT_PATH, outputFile.getAbsolutePath());
        intent.putExtra(InstafyCameraCaptureActivity.EXTRA_LENS_ID, lensId);

        pendingCaptureFile = outputFile;
        pendingCaptureUri = outputUri;
        pendingLensId = lensId;
        startActivityForResult(call, intent, "cameraCaptureResult");
    }

    @ActivityCallback
    private void cameraCaptureResult(PluginCall call, ActivityResult result) {
        File outputFile = pendingCaptureFile;
        Uri outputUri = pendingCaptureUri;
        String lensId = pendingLensId;
        Intent resultData = result.getData();
        Log.d(
            TAG,
            "Camera capture result received: resultCode=" +
            result.getResultCode() +
            " lens=" +
            lensId +
            " file=" +
            (outputFile != null ? outputFile.getAbsolutePath() : "null")
        );
        clearPendingCapture(false);

        if (outputFile == null || outputUri == null || lensId == null) {
            Log.e(TAG, "Camera capture result missing pending state.");
            call.reject("Camera capture did not initialize correctly.");
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK) {
            if (outputFile.exists()) {
                outputFile.delete();
            }
            String error =
                resultData != null
                    ? resultData.getStringExtra(InstafyCameraCaptureActivity.EXTRA_CAPTURE_ERROR)
                    : null;
            Log.w(TAG, "Camera capture cancelled or failed: " + error);
            call.resolve(
                buildCapturePayload(
                    null,
                    true,
                    error != null && !error.trim().isEmpty() ? error.trim() : "Camera capture was cancelled."
                )
            );
            return;
        }

        if (resultData != null) {
            lensId = normalizeLensId(resultData.getStringExtra(InstafyCameraCaptureActivity.EXTRA_LENS_ID));
        }
        if (!outputFile.exists()) {
            Log.e(TAG, "Camera capture finished without an output file.");
            call.reject("The camera capture did not produce an output file.");
            return;
        }

        JSObject capturePayload = buildCapturePayload(outputFile, outputUri, lensId);
        lastCapturePayload = capturePayload;
        selectedLensId = lensId;
        Log.d(TAG, "Camera capture completed successfully for lens=" + lensId);
        call.resolve(buildCapturePayload(capturePayload, false, null));
    }

    private void clearPendingCapture(boolean deleteFile) {
        if (deleteFile && pendingCaptureFile != null && pendingCaptureFile.exists()) {
            pendingCaptureFile.delete();
        }
        if (pendingCaptureUri != null && getActivity() != null) {
            getActivity().revokeUriPermission(
                pendingCaptureUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        }
        pendingCaptureFile = null;
        pendingCaptureUri = null;
        pendingLensId = null;
    }

    private boolean hasCameraHardware() {
        return getContext()
            .getPackageManager()
            .hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);
    }

    private String normalizeLensId(@Nullable String value) {
        if (value == null) {
            return selectedLensId;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        if ("front".equals(normalized) || "external".equals(normalized)) {
            return normalized;
        }
        return "rear";
    }

    private File createOutputFile(String lensId) throws IOException {
        File cacheDir = new File(getContext().getCacheDir(), CAPTURE_CACHE_DIR);
        if (!cacheDir.exists() && !cacheDir.mkdirs()) {
            throw new IOException("Unable to create the camera capture directory.");
        }
        return File.createTempFile(
            "camera-" + lensId + "-",
            ".jpg",
            cacheDir
        );
    }

    private JSArray buildAvailableLenses() {
        Map<String, JSObject> lenses = new LinkedHashMap<>();
        CameraManager manager = (CameraManager) getContext().getSystemService(CameraManager.class);
        if (manager != null) {
            try {
                for (String cameraId : manager.getCameraIdList()) {
                    CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
                    Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                    String lensId = "rear";
                    String title = "Rear camera";
                    if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT) {
                        lensId = "front";
                        title = "Front camera";
                    } else if (facing != null && facing == CameraCharacteristics.LENS_FACING_EXTERNAL) {
                        lensId = "external";
                        title = "External camera";
                    }
                    if (lenses.containsKey(lensId)) {
                        continue;
                    }
                    JSObject lens = new JSObject();
                    lens.put("id", lensId);
                    lens.put("title", title);
                    lens.put("available", true);
                    lens.put("nativeId", cameraId);
                    lens.put("selected", lensId.equals(selectedLensId));
                    lenses.put(lensId, lens);
                }
            } catch (Exception ignored) {
            }
        }

        JSArray output = new JSArray();
        for (String lensId : new String[] { "rear", "front", "external" }) {
            JSObject lens = lenses.get(lensId);
            if (lens != null) {
                output.put(lens);
            }
        }
        return output;
    }

    private String permissionStateLabel(PermissionState permissionState) {
        if (permissionState == PermissionState.GRANTED) {
            return "granted";
        }
        if (permissionState == PermissionState.PROMPT) {
            return "prompt";
        }
        if (permissionState == PermissionState.PROMPT_WITH_RATIONALE) {
            return "prompt-with-rationale";
        }
        return "denied";
    }

    private String nowIsoString() {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date());
    }

    private String resolveDeviceId() {
        String androidId = Settings.Secure.getString(
            getContext().getContentResolver(),
            Settings.Secure.ANDROID_ID
        );
        if (androidId != null) {
            String normalized = androidId.trim().toLowerCase(Locale.ROOT);
            if (!normalized.isEmpty()) {
                return normalized;
            }
        }
        return "android-device";
    }

    private String resolveDeviceLabel() {
        String manufacturer = Build.MANUFACTURER != null ? Build.MANUFACTURER.trim() : "";
        String model = Build.MODEL != null ? Build.MODEL.trim() : "";
        if (!manufacturer.isEmpty() && !model.isEmpty()) {
            if (model.toLowerCase(Locale.ROOT).startsWith(manufacturer.toLowerCase(Locale.ROOT))) {
                return model;
            }
            return manufacturer + " " + model;
        }
        if (!model.isEmpty()) {
            return model;
        }
        if (!manufacturer.isEmpty()) {
            return manufacturer;
        }
        return "Android device";
    }

    private String resolveProviderId() {
        return "camera:" + resolveDeviceId();
    }

    private JSObject buildStatusPayload(@Nullable String error) {
        PermissionState permissionState = getPermissionState("camera");
        JSObject payload = new JSObject();
        payload.put("supported", hasCameraHardware());
        payload.put("platform", "android");
        payload.put("backend", "phone_camera");
        payload.put("deviceId", resolveDeviceId());
        payload.put("deviceLabel", resolveDeviceLabel());
        payload.put("providerId", resolveProviderId());
        payload.put("permission", permissionStateLabel(permissionState));
        payload.put("permissionGranted", permissionState == PermissionState.GRANTED);
        payload.put(
            "canCapture",
            hasCameraHardware() &&
            permissionState == PermissionState.GRANTED &&
            getActivity() != null
        );
        payload.put("availableLenses", buildAvailableLenses());
        payload.put("selectedLens", selectedLensId);
        payload.put("lastCapture", lastCapturePayload != null ? lastCapturePayload : JSONObject.NULL);
        if (error != null && !error.trim().isEmpty()) {
            payload.put("error", error.trim());
        }
        return payload;
    }

    private JSObject buildCapturePayload(
        @Nullable JSObject capturePayload,
        boolean cancelled,
        @Nullable String error
    ) {
        JSObject payload = buildStatusPayload(error);
        payload.put("cancelled", cancelled);
        payload.put("capture", capturePayload != null ? capturePayload : JSONObject.NULL);
        return payload;
    }

    private JSObject buildCapturePayload(File outputFile, Uri outputUri, String lensId) {
        BitmapFactory.Options bitmapOptions = new BitmapFactory.Options();
        bitmapOptions.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(outputFile.getAbsolutePath(), bitmapOptions);

        JSObject payload = new JSObject();
        payload.put("captureId", "camera-" + System.currentTimeMillis());
        payload.put("backend", "phone_camera");
        payload.put("lens", lensId);
        payload.put("capturedAt", nowIsoString());
        payload.put("fileName", outputFile.getName());
        payload.put("filePath", outputFile.getAbsolutePath());
        payload.put("webPath", outputUri.toString());
        payload.put("mimeType", "image/jpeg");
        payload.put("format", "jpeg");
        payload.put("width", bitmapOptions.outWidth > 0 ? bitmapOptions.outWidth : JSONObject.NULL);
        payload.put("height", bitmapOptions.outHeight > 0 ? bitmapOptions.outHeight : JSONObject.NULL);
        payload.put("sizeBytes", outputFile.length());
        return payload;
    }
}
