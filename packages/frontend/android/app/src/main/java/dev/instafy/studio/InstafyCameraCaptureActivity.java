package dev.instafy.studio;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.widget.Button;
import android.widget.TextView;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.util.Locale;

public class InstafyCameraCaptureActivity extends AppCompatActivity {
    private static final String TAG = "InstafyCameraCapture";

    public static final String EXTRA_OUTPUT_PATH = "outputPath";
    public static final String EXTRA_LENS_ID = "lensId";
    public static final String EXTRA_CAPTURE_ERROR = "captureError";

    private PreviewView previewView;
    private Button closeButton;
    private Button switchButton;
    private Button shutterButton;
    private TextView lensLabel;

    @Nullable private ProcessCameraProvider cameraProvider;
    @Nullable private ImageCapture imageCapture;
    private boolean cameraReady = false;
    private String outputPath = "";
    private String currentLensId = "rear";

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_instafy_camera_capture);

        previewView = findViewById(R.id.instafy_camera_preview);
        closeButton = findViewById(R.id.instafy_camera_close);
        switchButton = findViewById(R.id.instafy_camera_switch);
        shutterButton = findViewById(R.id.instafy_camera_shutter);
        lensLabel = findViewById(R.id.instafy_camera_lens_label);

        outputPath = normalizeString(getIntent().getStringExtra(EXTRA_OUTPUT_PATH));
        currentLensId = normalizeLensId(getIntent().getStringExtra(EXTRA_LENS_ID));

        closeButton.setOnClickListener((view) -> finishCancelled("Camera capture was cancelled."));
        switchButton.setOnClickListener((view) -> switchLens());
        shutterButton.setOnClickListener((view) -> capturePhoto());

        updateLensUi();
        setCaptureControlsEnabled(false);
        closeButton.setEnabled(true);

        if (outputPath.isEmpty()) {
            finishWithError("Camera capture output path is missing.");
            return;
        }

        Log.d(TAG, "Starting in-app camera capture for lens=" + currentLensId + " outputPath=" + outputPath);
        startCamera();
    }

    @Override
    public void onBackPressed() {
        finishCancelled("Camera capture was cancelled.");
    }

    @Override
    protected void onDestroy() {
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
        super.onDestroy();
    }

    private void startCamera() {
        Log.d(TAG, "Requesting ProcessCameraProvider instance.");
        ListenableFuture<ProcessCameraProvider> providerFuture = ProcessCameraProvider.getInstance(this);
        providerFuture.addListener(() -> {
            try {
                cameraProvider = providerFuture.get();
                Log.d(TAG, "ProcessCameraProvider ready.");
                bindCameraUseCases();
            } catch (Exception error) {
                finishWithError(error.getLocalizedMessage() != null ? error.getLocalizedMessage() : "Unable to start the camera.");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindCameraUseCases() {
        if (cameraProvider == null) {
            finishWithError("The camera provider is unavailable.");
            return;
        }
        cameraReady = false;
        imageCapture = null;
        setCaptureControlsEnabled(false);

        CameraSelector selector = resolveCameraSelector(currentLensId);
        if (selector == null) {
            finishWithError("The requested camera lens is not available on this device.");
            return;
        }

        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        imageCapture = new ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build();

        try {
            cameraProvider.unbindAll();
            cameraProvider.bindToLifecycle(this, selector, preview, imageCapture);
            currentLensId = selector == CameraSelector.DEFAULT_FRONT_CAMERA ? "front" : "rear";
            cameraReady = true;
            updateLensUi();
            setCaptureControlsEnabled(true);
            Log.d(TAG, "Camera bound and ready for lens=" + currentLensId);
        } catch (Exception error) {
            finishWithError(error.getLocalizedMessage() != null ? error.getLocalizedMessage() : "Unable to bind the camera preview.");
        }
    }

    @Nullable
    private CameraSelector resolveCameraSelector(String lensId) {
        if (cameraProvider == null) {
            return null;
        }

        CameraSelector preferred =
            "front".equals(lensId) ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;
        if (hasCamera(preferred)) {
            return preferred;
        }

        CameraSelector fallback =
            preferred == CameraSelector.DEFAULT_FRONT_CAMERA
                ? CameraSelector.DEFAULT_BACK_CAMERA
                : CameraSelector.DEFAULT_FRONT_CAMERA;
        if (hasCamera(fallback)) {
            return fallback;
        }

        return null;
    }

    private boolean hasCamera(CameraSelector selector) {
        if (cameraProvider == null) {
            return false;
        }
        try {
            return cameraProvider.hasCamera(selector);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void switchLens() {
        Log.d(TAG, "Switching in-app camera lens from " + currentLensId);
        currentLensId = "front".equals(currentLensId) ? "rear" : "front";
        bindCameraUseCases();
    }

    private void updateLensUi() {
        boolean hasFront = hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA);
        boolean hasRear = hasCamera(CameraSelector.DEFAULT_BACK_CAMERA);
        switchButton.setEnabled(hasFront && hasRear);
        lensLabel.setText("front".equals(currentLensId) ? "Front camera" : "Rear camera");
    }

    private void capturePhoto() {
        if (imageCapture == null || !cameraReady) {
            Log.w(TAG, "Ignoring capture request because the camera is not ready yet.");
            return;
        }

        Log.d(TAG, "Capturing in-app photo for lens=" + currentLensId);
        setCaptureControlsEnabled(false);
        File outputFile = new File(outputPath);
        ImageCapture.OutputFileOptions options =
            new ImageCapture.OutputFileOptions.Builder(outputFile).build();
        imageCapture.takePicture(
            options,
            ContextCompat.getMainExecutor(this),
            new ImageCapture.OnImageSavedCallback() {
                @Override
                public void onImageSaved(ImageCapture.OutputFileResults outputFileResults) {
                    Log.d(TAG, "In-app photo capture saved successfully for lens=" + currentLensId);
                    Intent result = new Intent();
                    result.putExtra(EXTRA_LENS_ID, currentLensId);
                    setResult(Activity.RESULT_OK, result);
                    finish();
                }

                @Override
                public void onError(ImageCaptureException exception) {
                    Log.e(TAG, "In-app photo capture failed: " + exception.getMessage(), exception);
                    finishWithError(
                        exception.getMessage() != null ? exception.getMessage() : "Unable to save the captured photo."
                    );
                }
            }
        );
    }

    private void setCaptureControlsEnabled(boolean enabled) {
        closeButton.setEnabled(true);
        switchButton.setEnabled(enabled && hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) && hasCamera(CameraSelector.DEFAULT_BACK_CAMERA));
        shutterButton.setEnabled(enabled);
    }

    private void finishCancelled(@Nullable String message) {
        Log.d(TAG, "Finishing in-app capture as cancelled: " + message);
        Intent result = new Intent();
        if (message != null && !message.trim().isEmpty()) {
            result.putExtra(EXTRA_CAPTURE_ERROR, message.trim());
        }
        setResult(Activity.RESULT_CANCELED, result);
        finish();
    }

    private void finishWithError(String message) {
        Log.e(TAG, "Finishing in-app capture with error: " + message);
        Intent result = new Intent();
        result.putExtra(EXTRA_CAPTURE_ERROR, message);
        setResult(Activity.RESULT_CANCELED, result);
        finish();
    }

    private String normalizeLensId(@Nullable String value) {
        if (value == null) {
            return "rear";
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        if ("front".equals(normalized)) {
            return normalized;
        }
        return "rear";
    }

    private String normalizeString(@Nullable String value) {
        return value == null ? "" : value.trim();
    }
}
