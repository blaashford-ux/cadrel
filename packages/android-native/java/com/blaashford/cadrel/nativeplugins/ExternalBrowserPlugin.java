package com.blaashford.cadrel.nativeplugins;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens a page in the phone's browser. Google's file picker has to run there (inside the app it is refused its API key); it hands the choice
 * back through the app's own `cadrel-write://picked?...` / `cadrel-reader://picked?...` link, which the manifest sends to this app.
 * The contract is packages/write/src/mobile/externalBrowser.ts.
 */
@CapacitorPlugin(name = "ExternalBrowser")
public class ExternalBrowserPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        Uri uri = url == null ? null : Uri.parse(url);
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
            call.reject("Only https pages can be opened in the browser.", "BAD_URL");
            return;
        }
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, uri);
            view.addCategory(Intent.CATEGORY_BROWSABLE);
            view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(view);
            call.resolve();
        } catch (Exception e) {
            call.reject("There is no browser to open the page in.", "NO_BROWSER", e);
        }
    }
}
