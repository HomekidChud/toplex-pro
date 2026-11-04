package com.homekidchud.toplexpro;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;
import com.google.mediapipe.tasks.genai.llminference.ProgressListener;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * On-device language models for Toplix Pro (Android).
 *
 * Models are stored in the app's private storage, run through Google's MediaPipe LLM Inference
 * engine, and can use the phone's GPU (OpenCL) when the user allows it. Nothing is sent anywhere
 * while generating; the only network use is downloading a model file from huggingface.co.
 */
@CapacitorPlugin(name = "ToplixLocalLLM")
public class ToplixLocalLLMPlugin extends Plugin {
    private static final String EVENT = "llm";

    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Map<String, Call> downloads = new ConcurrentHashMap<>();
    private final Object engineLock = new Object();

    private LlmInference engine;
    private String loadedId;
    private String loadedBackend;
    private String loadedTemplate = "chatml";
    private int loadedMaxTokens = 1024;
    private volatile LlmInferenceSession activeSession;

    /* ---------------- helpers ---------------- */

    private File modelsDir() {
        File d = new File(getContext().getFilesDir(), "models");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private void emit(JSObject o) {
        notifyListeners(EVENT, o);
    }

    private static String safeId(String s) {
        String id = s == null ? "" : s.toLowerCase().replaceAll("[^a-z0-9._-]+", "-");
        if (id.length() > 60) id = id.substring(0, 60);
        return id;
    }

    private static boolean hasModelExt(String name) {
        String n = name == null ? "" : name.toLowerCase();
        return n.endsWith(".task") || n.endsWith(".litertlm");
    }

    private void writeMeta(String id, String name, String file, String template, int maxTokens, long size) throws Exception {
        JSONObject m = new JSONObject();
        m.put("id", id);
        m.put("name", name);
        m.put("file", file);
        m.put("template", template);
        m.put("maxTokens", maxTokens);
        m.put("size", size);
        try (OutputStream out = new FileOutputStream(new File(modelsDir(), id + ".json"))) {
            out.write(m.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    private JSONObject readMeta(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new JSONObject(new String(bos.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    /* ---------------- device status ---------------- */

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        boolean arm64 = false;
        for (String abi : Build.SUPPORTED_ABIS) if ("arm64-v8a".equals(abi)) arm64 = true;
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        boolean opencl = false;
        String[] paths = {
            "/vendor/lib64/libOpenCL.so", "/system/vendor/lib64/libOpenCL.so", "/system/lib64/libOpenCL.so",
            "/vendor/lib64/egl/libGLES_mali.so", "/vendor/lib64/libOpenCL-pixel.so", "/vendor/lib64/libOpenCL-car.so"
        };
        for (String p : paths) if (new File(p).exists()) opencl = true;
        r.put("supported", arm64 && Build.VERSION.SDK_INT >= 24);
        r.put("arm64", arm64);
        r.put("ramMb", mi.totalMem / (1024 * 1024));
        r.put("freeStorageMb", getContext().getFilesDir().getUsableSpace() / (1024 * 1024));
        r.put("gpuLikely", opencl);
        r.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        r.put("loaded", loadedId);
        r.put("backend", loadedBackend);
        call.resolve(r);
    }

    /* ---------------- model files ---------------- */

    @PluginMethod
    public void models(PluginCall call) {
        JSArray arr = new JSArray();
        File[] files = modelsDir().listFiles();
        if (files != null) {
            for (File f : files) {
                if (!f.getName().endsWith(".json")) continue;
                JSONObject m = readMeta(f);
                if (m == null) continue;
                File mf = new File(modelsDir(), m.optString("file"));
                if (!mf.exists()) continue;
                try {
                    m.put("size", mf.length());
                    arr.put(m);
                } catch (Exception ignored) { }
            }
        }
        JSObject r = new JSObject();
        r.put("models", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = safeId(call.getString("id"));
        synchronized (engineLock) {
            if (id.equals(loadedId)) closeEngine();
        }
        File meta = new File(modelsDir(), id + ".json");
        JSONObject m = meta.exists() ? readMeta(meta) : null;
        if (m != null) new File(modelsDir(), m.optString("file")).delete();
        meta.delete();
        new File(modelsDir(), id + ".part").delete();
        call.resolve();
    }

    /* ---------------- download from Hugging Face ---------------- */

    @PluginMethod
    public void download(PluginCall call) {
        final String id = safeId(call.getString("id"));
        final String url = call.getString("url", "");
        final String name = call.getString("name", id);
        final String template = call.getString("template", "chatml");
        final int maxTokens = call.getInt("maxTokens", 1024);
        final String token = call.getString("token", "");
        if (id.isEmpty() || !url.startsWith("https://huggingface.co/") || !hasModelExt(url.split("\\?")[0])) {
            call.reject("Models can only be downloaded from huggingface.co (.task or .litertlm files).");
            return;
        }
        final String ext = url.split("\\?")[0].toLowerCase().endsWith(".litertlm") ? ".litertlm" : ".task";
        call.resolve();   // progress and completion are reported through events

        io.execute(() -> {
            File part = new File(modelsDir(), id + ".part");
            File dest = new File(modelsDir(), id + ext);
            try {
                long have = part.exists() ? part.length() : 0;
                Request.Builder rb = new Request.Builder().url(url);
                if (have > 0) rb.header("Range", "bytes=" + have + "-");
                if (token != null && !token.isEmpty()) rb.header("Authorization", "Bearer " + token);
                OkHttpClient client = ToplixNativePlugin.httpClient().newBuilder()
                    .readTimeout(60, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build();
                Call c = client.newCall(rb.build());
                downloads.put(id, c);
                try (Response r = c.execute()) {
                    if (r.code() == 401 || r.code() == 403) {
                        fail(id, "Hugging Face refused access. Accept the model's license on huggingface.co, then paste a read access token.");
                        return;
                    }
                    if (r.code() == 416 && have > 0) {
                        // already complete
                        part.renameTo(dest);
                    } else if (!r.isSuccessful() || r.body() == null) {
                        fail(id, "Download failed (HTTP " + r.code() + ").");
                        return;
                    } else {
                        boolean append = r.code() == 206;
                        if (!append) have = 0;
                        long total = have + r.body().contentLength();
                        if (r.body().contentLength() > 0 && getContext().getFilesDir().getUsableSpace() < (total - have) + 200L * 1024 * 1024) {
                            fail(id, "Not enough free storage for this model.");
                            return;
                        }
                        long received = have, lastEmit = 0;
                        try (InputStream in = r.body().byteStream();
                             FileOutputStream out = new FileOutputStream(part, append)) {
                            byte[] buf = new byte[256 * 1024];
                            int n;
                            while ((n = in.read(buf)) > 0) {
                                out.write(buf, 0, n);
                                received += n;
                                long now = System.currentTimeMillis();
                                if (now - lastEmit > 300) {
                                    lastEmit = now;
                                    JSObject e = new JSObject();
                                    e.put("type", "download-progress");
                                    e.put("id", id);
                                    e.put("received", received);
                                    e.put("total", total);
                                    emit(e);
                                }
                            }
                        }
                        if (!part.renameTo(dest)) {
                            fail(id, "Could not save the model file.");
                            return;
                        }
                    }
                }
                writeMeta(id, name, dest.getName(), template, maxTokens, dest.length());
                JSObject done = new JSObject();
                done.put("type", "download-done");
                done.put("id", id);
                emit(done);
            } catch (Exception e) {
                if (downloads.get(id) != null && downloads.get(id).isCanceled()) {
                    JSObject x = new JSObject();
                    x.put("type", "download-cancelled");
                    x.put("id", id);
                    emit(x);
                } else {
                    fail(id, "Download interrupted: " + e.getMessage() + ". Tap Download again to resume.");
                }
            } finally {
                downloads.remove(id);
            }
        });
    }

    private void fail(String id, String message) {
        JSObject e = new JSObject();
        e.put("type", "download-error");
        e.put("id", id);
        e.put("message", message);
        emit(e);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String id = safeId(call.getString("id"));
        Call c = downloads.get(id);
        if (c != null) c.cancel();
        if (call.getBoolean("discard", false)) new File(modelsDir(), id + ".part").delete();
        call.resolve();
    }

    /* ---------------- import a model file the user already has ---------------- */

    @PluginMethod
    public void importModel(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(call, i, "importResult");
    }

    @ActivityCallback
    private void importResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null || data.getData() == null) {
            call.reject("No file selected");
            return;
        }
        final Uri uri = data.getData();
        final String template = call.getString("template", "gemma");
        final int maxTokens = call.getInt("maxTokens", 1024);
        String display = "model.task";
        Cursor cur = getContext().getContentResolver().query(uri, null, null, null, null);
        if (cur != null) {
            try {
                int idx = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && cur.moveToFirst()) display = cur.getString(idx);
            } finally { cur.close(); }
        }
        if (!hasModelExt(display)) {
            call.reject("Choose a .task or .litertlm model file.");
            return;
        }
        final String fileName = display;
        final String id = safeId(display.replaceAll("\\.(task|litertlm)$", ""));
        final String ext = display.toLowerCase().endsWith(".litertlm") ? ".litertlm" : ".task";
        io.execute(() -> {
            File dest = new File(modelsDir(), id + ext);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 FileOutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[256 * 1024];
                long copied = 0, lastEmit = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    copied += n;
                    long now = System.currentTimeMillis();
                    if (now - lastEmit > 300) {
                        lastEmit = now;
                        JSObject e = new JSObject();
                        e.put("type", "download-progress");
                        e.put("id", id);
                        e.put("received", copied);
                        e.put("total", 0);
                        emit(e);
                    }
                }
                writeMeta(id, fileName, dest.getName(), template, maxTokens, dest.length());
                JSObject r = new JSObject();
                r.put("id", id);
                call.resolve(r);
            } catch (Exception e) {
                dest.delete();
                call.reject("Could not import the file: " + e.getMessage());
            }
        });
    }

    /* ---------------- load / generate ---------------- */

    private void closeEngine() {
        try { if (activeSession != null) activeSession.close(); } catch (Exception ignored) { }
        activeSession = null;
        try { if (engine != null) engine.close(); } catch (Exception ignored) { }
        engine = null;
        loadedId = null;
        loadedBackend = null;
    }

    private LlmInference create(File model, int maxTokens, LlmInference.Backend backend) {
        LlmInference.LlmInferenceOptions opts = LlmInference.LlmInferenceOptions.builder()
            .setModelPath(model.getAbsolutePath())
            .setMaxTokens(maxTokens)
            .setMaxTopK(64)
            .setPreferredBackend(backend)
            .build();
        return LlmInference.createFromOptions(getContext(), opts);
    }

    @PluginMethod
    public void load(PluginCall call) {
        final String id = safeId(call.getString("id"));
        final boolean wantGpu = "gpu".equals(call.getString("backend", "cpu"));
        io.execute(() -> {
            synchronized (engineLock) {
                try {
                    if (id.equals(loadedId) && engine != null && (wantGpu == "gpu".equals(loadedBackend))) {
                        JSObject r = new JSObject();
                        r.put("backend", loadedBackend);
                        call.resolve(r);
                        return;
                    }
                    closeEngine();
                    File metaFile = new File(modelsDir(), id + ".json");
                    JSONObject m = metaFile.exists() ? readMeta(metaFile) : null;
                    if (m == null) { call.reject("Model not found. Download it first."); return; }
                    File model = new File(modelsDir(), m.optString("file"));
                    int maxTokens = m.optInt("maxTokens", 1024);
                    String used = wantGpu ? "gpu" : "cpu";
                    String gpuError = null;
                    LlmInference e = null;
                    if (wantGpu) {
                        try {
                            e = create(model, maxTokens, LlmInference.Backend.GPU);
                        } catch (Throwable t) {
                            gpuError = String.valueOf(t.getMessage());
                            used = "cpu";
                        }
                    }
                    if (e == null) e = create(model, maxTokens, LlmInference.Backend.CPU);
                    engine = e;
                    loadedId = id;
                    loadedBackend = used;
                    loadedTemplate = m.optString("template", "chatml");
                    loadedMaxTokens = maxTokens;
                    JSObject r = new JSObject();
                    r.put("backend", used);
                    if (gpuError != null) r.put("gpuError", gpuError);
                    call.resolve(r);
                } catch (UnsatisfiedLinkError ule) {
                    call.reject("This phone can't run on-device models (missing native library).");
                } catch (Throwable t) {
                    closeEngine();
                    String msg = String.valueOf(t.getMessage());
                    if (t instanceof OutOfMemoryError || msg.toLowerCase().contains("memory")) {
                        msg = "Not enough memory to load this model. Try a smaller one.";
                    }
                    call.reject("Could not load the model: " + msg);
                }
            }
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        synchronized (engineLock) { closeEngine(); }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        LlmInferenceSession s = activeSession;
        if (s != null) {
            try { s.cancelGenerateResponseAsync(); } catch (Throwable ignored) { }
        }
        call.resolve();
    }

    private static String clean(String s) {
        return s.replace("<end_of_turn>", "").replace("<|im_end|>", "").replace("<|endoftext|>", "")
            .replace("<eos>", "").replace("</s>", "");
    }

    /** Builds the chat prompt for the loaded model, dropping the oldest turns if it would not fit. */
    private String buildPrompt(String template, String system, List<String[]> turns, int maxTokens) {
        int budget = (int) ((maxTokens - 320) * 3.0);
        if (budget < 600) budget = 600;
        List<String[]> use = new ArrayList<>(turns);
        while (use.size() > 1) {
            int len = system == null ? 0 : system.length();
            for (String[] t : use) len += t[1].length() + 24;
            if (len <= budget) break;
            use.remove(0);
        }
        StringBuilder sb = new StringBuilder();
        if ("gemma".equals(template)) {
            boolean first = true;
            for (String[] t : use) {
                boolean user = "user".equals(t[0]);
                sb.append("<start_of_turn>").append(user ? "user" : "model").append("\n");
                if (user && first && system != null && !system.isEmpty()) sb.append(system).append("\n\n");
                if (user) first = false;
                sb.append(t[1].trim()).append("<end_of_turn>\n");
            }
            sb.append("<start_of_turn>model\n");
        } else if ("plain".equals(template)) {
            if (system != null && !system.isEmpty()) sb.append(system).append("\n\n");
            for (String[] t : use) {
                sb.append("user".equals(t[0]) ? "User: " : "Assistant: ").append(t[1].trim()).append("\n");
            }
            sb.append("Assistant:");
        } else {   // chatml (Qwen, SmolLM and most others)
            if (system != null && !system.isEmpty()) sb.append("<|im_start|>system\n").append(system).append("<|im_end|>\n");
            for (String[] t : use) {
                sb.append("<|im_start|>").append("user".equals(t[0]) ? "user" : "assistant").append("\n")
                  .append(t[1].trim()).append("<|im_end|>\n");
            }
            sb.append("<|im_start|>assistant\n");
        }
        return sb.toString();
    }

    @PluginMethod
    public void generate(PluginCall call) {
        final String rid = call.getString("rid", "r");
        final String system = call.getString("system", "");
        final float temperature = call.getFloat("temperature", 0.7f);
        final JSArray messages = call.getArray("messages");
        io.execute(() -> {
            synchronized (engineLock) {
                if (engine == null) { call.reject("No model is loaded."); return; }
                LlmInferenceSession session = null;
                try {
                    List<String[]> turns = new ArrayList<>();
                    JSONArray arr = messages == null ? new JSONArray() : messages;
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject o = arr.getJSONObject(i);
                        String role = o.optString("role", "user");
                        if ("system".equals(role)) continue;
                        turns.add(new String[]{"assistant".equals(role) ? "assistant" : "user", o.optString("content", "")});
                    }
                    String prompt = buildPrompt(loadedTemplate, system, turns, loadedMaxTokens);
                    LlmInferenceSession.LlmInferenceSessionOptions so = LlmInferenceSession.LlmInferenceSessionOptions.builder()
                        .setTopK(40)
                        .setTopP(0.95f)
                        .setTemperature(Math.max(0.05f, Math.min(1.5f, temperature)))
                        .setRandomSeed((int) (System.currentTimeMillis() & 0x7fffffff))
                        .build();
                    session = LlmInferenceSession.createFromOptions(engine, so);
                    activeSession = session;
                    session.addQueryChunk(prompt);

                    ProgressListener<String> listener = (partial, done) -> {
                        JSObject e = new JSObject();
                        e.put("type", "token");
                        e.put("rid", rid);
                        e.put("text", partial == null ? "" : clean(partial));
                        e.put("done", done);
                        emit(e);
                    };
                    ListenableFuture<String> future = session.generateResponseAsync(listener);
                    future.get();   // blocks this worker thread until generation finishes
                    JSObject r = new JSObject();
                    r.put("ok", true);
                    call.resolve(r);
                } catch (Throwable t) {
                    String msg = String.valueOf(t.getMessage());
                    if (msg.toLowerCase().contains("cancel")) {
                        JSObject r = new JSObject();
                        r.put("stopped", true);
                        call.resolve(r);
                    } else {
                        call.reject("Generation failed: " + msg);
                    }
                } finally {
                    activeSession = null;
                    try { if (session != null) session.close(); } catch (Throwable ignored) { }
                }
            }
        });
    }
}
