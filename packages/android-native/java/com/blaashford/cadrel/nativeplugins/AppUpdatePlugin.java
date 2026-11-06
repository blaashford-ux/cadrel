package com.blaashford.cadrel.nativeplugins;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Updates the app from its GitHub release: downloads the APK, checks it against the release's SHA256SUMS.txt and hands it to Android's installer.
 * The contract is packages/write/src/mobile/appUpdate.ts. Rejects with code NEEDS_PERMISSION until the person has allowed this app to install
 * apps (Android asks once, in Settings, which this opens), NO_CHECKSUM when the release has no sums file, CHECKSUM when the file does not match.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    /** Only files from this project's releases may be downloaded and run (same rule as isReleaseDownloadUrl in the web code). */
    private static final String RELEASE_PREFIX = "https://github.com/blaashford-ux/cadrel/releases/download/";
    private static final Pattern APK_NAME = Pattern.compile("^[A-Za-z0-9._-]{1,100}\\.apk$");
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void install(final PluginCall call) {
        final String url = call.getString("url");
        final String name = call.getString("name");
        final String sumsUrl = call.getString("sumsUrl");
        if (url == null || !url.toLowerCase(Locale.ROOT).startsWith(RELEASE_PREFIX)) {
            call.reject("That is not a download from this project's releases.", "BAD_URL");
            return;
        }
        if (name == null || !APK_NAME.matcher(name).matches()) {
            call.reject("That is not an app file name.", "BAD_NAME");
            return;
        }
        if (sumsUrl == null || !sumsUrl.toLowerCase(Locale.ROOT).startsWith(RELEASE_PREFIX)) {
            call.reject("This release has no SHA256SUMS.txt, so the download cannot be checked.", "NO_CHECKSUM");
            return;
        }
        if (!getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("Allow this app to install updates, then try again.", "NEEDS_PERMISSION");
            return;
        }
        pool.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new Failure("Could not make room for the download.", "STORAGE");
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();

                String expected = expectedHash(fetchText(sumsUrl), name);
                if (expected == null) throw new Failure("SHA256SUMS.txt does not list " + name + ".", "NO_CHECKSUM");

                File part = new File(dir, name + ".part");
                String actual = download(url, part);
                if (!actual.equals(expected)) {
                    part.delete();
                    throw new Failure("The download does not match its checksum, so it was discarded.", "CHECKSUM");
                }
                File apk = new File(dir, name);
                if (!part.renameTo(apk)) throw new Failure("Could not save the download.", "STORAGE");

                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent open = new Intent(Intent.ACTION_VIEW);
                open.setDataAndType(uri, "application/vnd.android.package-archive");
                open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(open);
                call.resolve();
            } catch (Failure f) {
                call.reject(f.getMessage(), f.code);
            } catch (Exception e) {
                call.reject("The update could not be downloaded: " + e.getMessage(), "DOWNLOAD", e);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
    }

    private static final class Failure extends Exception {
        final String code;

        Failure(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true); // GitHub hands the file to its CDN
        if (c.getResponseCode() != 200) throw new Failure("GitHub answered " + c.getResponseCode() + " for the download.", "DOWNLOAD");
        if (!"https".equals(c.getURL().getProtocol())) throw new Failure("The download was redirected away from https.", "DOWNLOAD");
        return c;
    }

    private static String fetchText(String url) throws Exception {
        HttpURLConnection c = open(url);
        try (InputStream in = c.getInputStream()) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 65536) throw new Failure("SHA256SUMS.txt is too large.", "NO_CHECKSUM");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    /** The hash listed for `name` in `sha256sum` output ("<64 hex>  <name>" or "<64 hex> *<name>"), lower case, or null. */
    static String expectedHash(String sums, String name) {
        Matcher m = Pattern.compile("^([0-9A-Fa-f]{64})\\s+\\*?" + Pattern.quote(name) + "\\s*$", Pattern.MULTILINE).matcher(sums);
        return m.find() ? m.group(1).toLowerCase(Locale.ROOT) : null;
    }

    /** Saves the file and returns its SHA-256 (lower case hex), reporting progress. */
    private String download(String url, File to) throws Exception {
        HttpURLConnection c = open(url);
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(to)) {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            long total = Math.max(0, c.getContentLengthLong());
            long received = 0;
            long lastReport = 0;
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                sha.update(buf, 0, n);
                received += n;
                long now = System.currentTimeMillis();
                if (now - lastReport >= 150) {
                    lastReport = now;
                    progress(received, total);
                }
            }
            progress(received, total);
            StringBuilder hex = new StringBuilder();
            for (byte b : sha.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } finally {
            c.disconnect();
        }
    }

    private void progress(long received, long total) {
        JSObject p = new JSObject();
        p.put("received", received);
        p.put("total", total);
        notifyListeners("progress", p);
    }
}
