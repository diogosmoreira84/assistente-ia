package local.dashboard;

import android.app.Activity;
import android.content.Intent;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean();
    private Camera camera;
    private SurfaceHolder surface;
    private boolean resumed;
    private boolean complete;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        FrameLayout layout = new FrameLayout(this);
        SurfaceView preview = new SurfaceView(this);
        preview.getHolder().addCallback(this);
        layout.addView(preview);
        TextView instruction = new TextView(this);
        instruction.setGravity(Gravity.CENTER);
        instruction.setText("Point the camera at the QR code on your Assistente IA portal.");
        instruction.setTextColor(0xffffffff);
        instruction.setBackgroundColor(0xcc101116);
        instruction.setPadding(12, 16, 12, 16);
        layout.addView(instruction, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        setContentView(layout);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        startCamera();
    }

    @Override protected void onPause() {
        resumed = false;
        stopCamera();
        super.onPause();
    }

    @Override protected void onDestroy() {
        decoder.shutdownNow();
        super.onDestroy();
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        surface = holder;
        startCamera();
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override public void surfaceDestroyed(SurfaceHolder holder) {
        surface = null;
        stopCamera();
    }

    private void startCamera() {
        if (!resumed || surface == null || camera != null || complete) return;
        try {
            int selected = -1;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int id = 0; id < Camera.getNumberOfCameras(); id++) {
                Camera.getCameraInfo(id, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                    selected = id;
                    break;
                }
            }
            if (selected < 0) throw new IOException("Rear camera unavailable");
            camera = Camera.open(selected);
            int rotation = getWindowManager().getDefaultDisplay().getRotation();
            int degrees = rotation == Surface.ROTATION_90 ? 90 : rotation == Surface.ROTATION_180
                    ? 180 : rotation == Surface.ROTATION_270 ? 270 : 0;
            camera.setDisplayOrientation((info.orientation - degrees + 360) % 360);
            Camera.Parameters parameters = camera.getParameters();
            if (parameters.getSupportedFocusModes() != null
                    && parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            Camera.Size choice = null;
            for (Camera.Size size : parameters.getSupportedPreviewSizes()) {
                if (size.width >= 640 && size.width <= 1280 && (choice == null || size.width > choice.width)) choice = size;
            }
            if (choice != null) parameters.setPreviewSize(choice.width, choice.height);
            camera.setParameters(parameters);
            camera.setPreviewDisplay(surface);
            camera.setPreviewCallback(this);
            camera.startPreview();
        } catch (IOException | RuntimeException e) {
            stopCamera();
            complete = true;
            setResult(RESULT_CANCELED, new Intent().putExtra("error", "Could not open the camera. Use the manual code instead."));
            finish();
        }
    }

    private void stopCamera() {
        if (camera == null) return;
        camera.setPreviewCallback(null);
        camera.release();
        camera = null;
    }

    @Override public void onPreviewFrame(byte[] frame, Camera device) {
        if (frame == null || complete || decoder.isShutdown() || !decoding.compareAndSet(false, true)) return;
        Camera.Size size = device.getParameters().getPreviewSize();
        final int width = size.width, height = size.height;
        final byte[] luminance = java.util.Arrays.copyOf(frame, width * height);
        decoder.execute(new Runnable() {
            public void run() {
                try {
                    PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                            luminance, width, height, 0, 0, width, height, false);
                    final String code = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source))).getText();
                    if (code.startsWith("assistenteia://pair?") && code.length() <= 2048) {
                        runOnUiThread(new Runnable() {
                            public void run() {
                                if (complete || !resumed) return;
                                complete = true;
                                setResult(RESULT_OK, new Intent().putExtra("link", code));
                                finish();
                            }
                        });
                    }
                } catch (ReaderException ignored) {
                    // The next camera frame may contain a readable QR code.
                } finally {
                    decoding.set(false);
                }
            }
        });
    }
}
