package com.blaashford.cadrel.nativeplugins;

import android.app.Activity;
import android.app.PendingIntent;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import java.util.Collections;

/**
 * Native Google authorization for Drive's `drive.file` scope (only files the app creates or the person picks for it).
 * The contract is packages/write/src/mobile/driveAuth.ts: `authorize()` resolves `{ accessToken }`, showing Google's account and consent screens
 * the first time. Needs an Android OAuth client in the Google Cloud project for this app's id and signing key (docs/ANDROID.md).
 */
@CapacitorPlugin(name = "DriveAuth")
public class DriveAuthPlugin extends Plugin {
    private static final String DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
    private ActivityResultLauncher<IntentSenderRequest> consent;
    private PluginCall waiting;

    /** Registered while the activity is being created, which Android requires of a result launcher. */
    @Override
    public void load() {
        consent = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            PluginCall call = waiting;
            waiting = null;
            if (call == null) return;
            if (result.getResultCode() != Activity.RESULT_OK) {
                call.reject("Google sign-in was cancelled.", "CANCELLED");
                return;
            }
            try {
                finish(call, Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(result.getData()));
            } catch (Exception e) {
                call.reject("Google sign-in failed: " + e.getMessage(), "AUTH", e);
            }
        });
    }

    @PluginMethod
    public void authorize(final PluginCall call) {
        if (waiting != null) {
            call.reject("Google sign-in is already open.", "BUSY");
            return;
        }
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(Collections.singletonList(new Scope(DRIVE_FILE))).build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    finish(call, result);
                    return;
                }
                PendingIntent pending = result.getPendingIntent();
                if (pending == null) {
                    call.reject("Google sign-in could not be shown.", "AUTH");
                    return;
                }
                waiting = call;
                consent.launch(new IntentSenderRequest.Builder(pending.getIntentSender()).build());
            })
            .addOnFailureListener(e -> call.reject("Google sign-in failed: " + e.getMessage(), "AUTH", e));
    }

    private static void finish(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null || token.isEmpty()) {
            call.reject("Google did not give access to Drive.", "AUTH");
            return;
        }
        JSObject out = new JSObject();
        out.put("accessToken", token);
        call.resolve(out);
    }
}
