package com.homekidchud.toplexpro;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
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
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Native helpers for Toplix Pro on Android:
 *  - loopback HTTP listener for the "Sign in with ChatGPT" redirect (127.0.0.1)
 *  - HTTPS requests to OpenAI's auth/API hosts (token endpoint is not CORS-enabled)
 *  - encrypted credential storage (Android Keystore, AES-GCM)
 *  - yes/no detection of the ChatGPT and Claude apps (no data is read from them)
 */
@CapacitorPlugin(name = "ToplixNative")
public class ToplixNativePlugin extends Plugin {
    private static final String KEY_ALIAS = "toplix_secure_key";
    private static final String PREFS = "toplix_secure";
    private static final List<String> HTTP_HOSTS = Arrays.asList("auth.openai.com", "api.openai.com");

    private final ExecutorService io = Executors.newCachedThreadPool();
    private ServerSocket server;
    private String callbackUrl;
    private PluginCall waiting;

    /* ---------------- Loopback listener ---------------- */

    @PluginMethod
    public void loopbackStart(PluginCall call) {
        stopServer();
        int preferred = call.getInt("port", 1455);
        ServerSocket s;
        try {
            s = new ServerSocket(preferred, 5, InetAddress.getByName("127.0.0.1"));
        } catch (Exception e) {
            try {
                s = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"));
            } catch (Exception e2) {
                call.reject("Could not open a local sign-in listener");
                return;
            }
        }
        synchronized (this) {
            server = s;
            callbackUrl = null;
            waiting = null;
        }
        final ServerSocket fs = s;
        io.execute(() -> acceptLoop(fs));
        JSObject r = new JSObject();
        r.put("port", s.getLocalPort());
        call.resolve(r);
    }

    private void acceptLoop(ServerSocket s) {
        while (!s.isClosed()) {
            try (Socket client = s.accept()) {
                client.setSoTimeout(5000);
                InputStream in = client.getInputStream();
                ByteArrayOutputStream head = new ByteArrayOutputStream();
                int b, prev = 0;
                while ((b = in.read()) != -1 && head.size() < 8192) {
                    head.write(b);
                    if (b == '\n' && prev == '\n') break;
                    if (b != '\r') prev = b;
                }
                String first = new String(head.toByteArray(), StandardCharsets.UTF_8).split("\r?\n")[0];
                String[] parts = first.split(" ");
                String target = parts.length > 1 ? parts[1] : "/";
                OutputStream out = client.getOutputStream();
                if (target.startsWith("/auth/callback")) {
                    String html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                        + "<title>Toplix Pro</title><body style='font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f7f7f8;color:#111827'>"
                        + "<div style='text-align:center;padding:24px'><h2>Almost done</h2><p>Return to Toplix Pro to continue.</p>"
                        + "<p><a href='toplex://auth/done' style='display:inline-block;padding:12px 20px;border-radius:10px;background:#111827;color:#fff;text-decoration:none'>Open Toplix Pro</a></p></div></body>";
                    byte[] body = html.getBytes(StandardCharsets.UTF_8);
                    String hdr = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: "
                        + body.length + "\r\nConnection: close\r\n\r\n";
                    out.write(hdr.getBytes(StandardCharsets.UTF_8));
                    out.write(body);
                    out.flush();
                    deliver("http://127.0.0.1:" + s.getLocalPort() + target);
                    return;
                } else {
                    out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
            } catch (Exception e) {
                if (s.isClosed()) return;
            }
        }
    }

    private synchronized void deliver(String url) {
        callbackUrl = url;
        if (waiting != null) {
            PluginCall c = waiting;
            waiting = null;
            JSObject r = new JSObject();
            r.put("url", url);
            c.resolve(r);
            getBridge().releaseCall(c);
        }
        closeQuietly();
    }

    @PluginMethod
    public synchronized void loopbackWait(PluginCall call) {
        if (callbackUrl != null) {
            JSObject r = new JSObject();
            r.put("url", callbackUrl);
            call.resolve(r);
            return;
        }
        if (server == null) {
            call.reject("No sign-in in progress");
            return;
        }
        getBridge().saveCall(call);
        waiting = call;
    }

    @PluginMethod
    public void loopbackStop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    private synchronized void stopServer() {
        closeQuietly();
        if (waiting != null) {
            PluginCall c = waiting;
            waiting = null;
            c.reject("Sign-in cancelled");
            getBridge().releaseCall(c);
        }
        callbackUrl = null;
    }

    private void closeQuietly() {
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        server = null;
    }

    /* ---------------- HTTP ---------------- */

    @PluginMethod
    public void http(PluginCall call) {
        final String url = call.getString("url", "");
        final String method = call.getString("method", "GET");
        final String body = call.getString("body");
        final JSObject headers = call.getObject("headers");
        try {
            URL u = new URL(url);
            if (!"https".equals(u.getProtocol()) || !HTTP_HOSTS.contains(u.getHost())) {
                call.reject("Host not allowed");
                return;
            }
        } catch (Exception e) {
            call.reject("Bad URL");
            return;
        }
        io.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod(method);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                if (headers != null) {
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        c.setRequestProperty(k, headers.getString(k));
                    }
                }
                if (body != null) {
                    c.setDoOutput(true);
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = c.getResponseCode();
                InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                }
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("text", new String(bos.toByteArray(), StandardCharsets.UTF_8));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Network error: " + e.getMessage());
            }
        });
    }

    /* ---------------- Secure storage ---------------- */

    private SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
            return kg.generateKey();
        }
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        try {
            String key = call.getString("key");
            String value = call.getString("value", "");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] ct = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key, packed).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Secure storage failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        JSObject r = new JSObject();
        try {
            String packed = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(call.getString("key"), null);
            if (packed == null) { r.put("value", JSObject.NULL); call.resolve(r); return; }
            String[] p = packed.split(":");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(p[0], Base64.NO_WRAP)));
            r.put("value", new String(cipher.doFinal(Base64.decode(p[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            call.resolve(r);
        } catch (Exception e) {
            r.put("value", JSObject.NULL);
            call.resolve(r);
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(call.getString("key")).apply();
        call.resolve();
    }

    /* ---------------- Apps + browser ---------------- */

    private boolean installed(String pkg) {
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @PluginMethod
    public void detectApps(PluginCall call) {
        JSObject r = new JSObject();
        r.put("chatgpt", installed("com.openai.chatgpt"));
        r.put("claude", installed("com.anthropic.claude"));
        call.resolve(r);
    }

    @PluginMethod
    public void launchApp(PluginCall call) {
        String id = call.getString("app", "");
        String pkg = "chatgpt".equals(id) ? "com.openai.chatgpt" : "claude".equals(id) ? "com.anthropic.claude" : null;
        Intent i = pkg == null ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) { call.reject("App not installed"); return; }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) { call.reject("Only https links can be opened"); return; }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }
}
