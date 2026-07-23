package dev.instafy.studio;

import android.Manifest;
import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.net.wifi.WifiManager;
import androidx.annotation.Nullable;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@CapacitorPlugin(
    name = "InstafyLanDiscoveryBridge",
    permissions = {
        @Permission(
            alias = "multicast",
            strings = {
                Manifest.permission.ACCESS_WIFI_STATE,
                Manifest.permission.CHANGE_WIFI_MULTICAST_STATE
            }
        )
    }
)
public class InstafyLanDiscoveryBridgePlugin extends Plugin {

    private static final String EVENT_LAN_DISCOVERY = "lanDiscovery";
    private static final String SERVICE_TYPE = "_instafy-speech._tcp.";

    @Nullable private NsdManager nsdManager;
    @Nullable private NsdManager.DiscoveryListener discoveryListener;
    @Nullable private WifiManager.MulticastLock multicastLock;
    private final Map<String, JSObject> services = new LinkedHashMap<>();
    private final List<String> serviceOrder = new ArrayList<>();
    private final List<String> resolvingKeys = new ArrayList<>();
    private String state = "idle";
    @Nullable private String lastError;
    @Nullable private String updatedAt;

    @Override
    public void load() {
        super.load();
        nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        if (nsdManager == null) {
            state = "unsupported";
            lastError = "Android NSD service is unavailable on this device.";
            touch();
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatusPayload());
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (nsdManager == null) {
            state = "unsupported";
            lastError = "Android NSD service is unavailable on this device.";
            touch();
            call.resolve(buildStatusPayload());
            return;
        }
        if (discoveryListener != null) {
            state = "scanning";
            touch();
            publishStatus();
            call.resolve(buildStatusPayload());
            return;
        }

        discoveryListener =
            new NsdManager.DiscoveryListener() {
                @Override
                public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    handleDiscoveryFailure("start", errorCode);
                }

                @Override
                public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                    handleDiscoveryFailure("stop", errorCode);
                }

                @Override
                public void onDiscoveryStarted(String serviceType) {
                    state = "scanning";
                    lastError = null;
                    touch();
                    publishStatus();
                }

                @Override
                public void onDiscoveryStopped(String serviceType) {
                    state = "idle";
                    touch();
                    publishStatus();
                }

                @Override
                public void onServiceFound(NsdServiceInfo serviceInfo) {
                    if (!matchesServiceType(serviceInfo.getServiceType())) {
                        return;
                    }
                    resolveService(serviceInfo);
                }

                @Override
                public void onServiceLost(NsdServiceInfo serviceInfo) {
                    String key = serviceKey(serviceInfo);
                    services.remove(key);
                    serviceOrder.removeAll(Arrays.asList(key));
                    resolvingKeys.remove(key);
                    touch();
                    publishStatus();
                }
            };

        state = "scanning";
        lastError = null;
        acquireMulticastLock();
        touch();
        publishStatus();
        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        call.resolve(buildStatusPayload());
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopDiscoveryInternal(true);
        call.resolve(buildStatusPayload());
    }

    private void stopDiscoveryInternal(boolean clearServices) {
        if (nsdManager != null && discoveryListener != null) {
            try {
                nsdManager.stopServiceDiscovery(discoveryListener);
            } catch (RuntimeException ignored) {
            }
        }
        discoveryListener = null;
        state = "idle";
        lastError = null;
        releaseMulticastLock();
        resolvingKeys.clear();
        if (clearServices) {
            services.clear();
            serviceOrder.clear();
        }
        touch();
        publishStatus();
    }

    private void resolveService(NsdServiceInfo serviceInfo) {
        if (nsdManager == null) {
            return;
        }
        String key = serviceKey(serviceInfo);
        if (resolvingKeys.contains(key)) {
            return;
        }
        resolvingKeys.add(key);
        nsdManager.resolveService(
            serviceInfo,
            new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    resolvingKeys.remove(key);
                    lastError = String.format(
                        Locale.ROOT,
                        "Android NSD resolve failed for %s (%d).",
                        serviceInfo.getServiceName(),
                        errorCode
                    );
                    touch();
                    publishStatus();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo resolvedServiceInfo) {
                    resolvingKeys.remove(key);
                    JSObject payload = buildServicePayload(resolvedServiceInfo);
                    services.put(key, payload);
                    if (!serviceOrder.contains(key)) {
                        serviceOrder.add(key);
                    }
                    touch();
                    publishStatus();
                }
            }
        );
    }

    private void handleDiscoveryFailure(String phase, int errorCode) {
        stopDiscoveryInternal(false);
        state = "error";
        lastError =
            String.format(Locale.ROOT, "Android NSD %s discovery failed (%d).", phase, errorCode);
        touch();
        publishStatus();
    }

    private boolean matchesServiceType(@Nullable String serviceType) {
        if (serviceType == null) {
            return false;
        }
        String normalized = serviceType.trim().toLowerCase(Locale.ROOT);
        return normalized.equals(SERVICE_TYPE) || normalized.equals("_instafy-speech._tcp");
    }

    private String serviceKey(NsdServiceInfo serviceInfo) {
        String name = serviceInfo.getServiceName() == null ? "" : serviceInfo.getServiceName();
        String type = serviceInfo.getServiceType() == null ? "" : serviceInfo.getServiceType();
        return name + "|" + type;
    }

    private JSObject buildStatusPayload() {
        JSObject payload = new JSObject();
        payload.put("snapshot", buildSnapshot());
        return payload;
    }

    private JSObject buildSnapshot() {
        JSArray serviceArray = new JSArray();
        for (String key : serviceOrder) {
            JSObject service = services.get(key);
            if (service != null) {
                serviceArray.put(service);
            }
        }
        JSObject snapshot = new JSObject();
        snapshot.put("state", state);
        snapshot.put("services", serviceArray);
        snapshot.put("lastError", lastError);
        snapshot.put("updatedAt", updatedAt);
        return snapshot;
    }

    private void publishStatus() {
        notifyListeners(EVENT_LAN_DISCOVERY, buildStatusPayload(), true);
    }

    private void acquireMulticastLock() {
        if (multicastLock != null && multicastLock.isHeld()) {
            return;
        }
        try {
            WifiManager wifiManager =
                (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                return;
            }
            WifiManager.MulticastLock nextLock = wifiManager.createMulticastLock("instafy-lan-discovery");
            nextLock.setReferenceCounted(true);
            nextLock.acquire();
            multicastLock = nextLock;
        } catch (Throwable ignored) {
            multicastLock = null;
        }
    }

    private void releaseMulticastLock() {
        if (multicastLock == null) {
            return;
        }
        try {
            if (multicastLock.isHeld()) {
                multicastLock.release();
            }
        } catch (Throwable ignored) {
            // Best effort only.
        } finally {
            multicastLock = null;
        }
    }

    private void touch() {
        updatedAt = java.time.Instant.now().toString();
    }

    private JSObject buildServicePayload(NsdServiceInfo serviceInfo) {
        JSObject payload = new JSObject();
        String host = resolveHost(serviceInfo.getHost());
        int port = serviceInfo.getPort();
        String tokenHint = resolveAttribute(serviceInfo, "token_hint");
        String hostMode = resolveAttribute(serviceInfo, "host_mode");
        String authRequiredValue = resolveAttribute(serviceInfo, "auth_required");
        boolean authRequired = "1".equals(authRequiredValue) || "true".equalsIgnoreCase(authRequiredValue);

        payload.put("serviceName", serviceInfo.getServiceName());
        payload.put("serviceType", serviceInfo.getServiceType());
        payload.put("host", host);
        payload.put("port", port > 0 ? port : null);
        payload.put("baseUrl", host != null && port > 0 ? "http://" + host + ":" + port : null);
        payload.put("tokenHint", tokenHint);
        payload.put("hostMode", hostMode);
        payload.put("authRequired", authRequired);
        payload.put("updatedAt", java.time.Instant.now().toString());
        return payload;
    }

    @Nullable
    private String resolveHost(@Nullable InetAddress address) {
        if (address == null) {
            return null;
        }
        String hostAddress = address.getHostAddress();
        if (hostAddress != null && !hostAddress.trim().isEmpty()) {
            return hostAddress.trim();
        }
        String hostName = address.getHostName();
        if (hostName != null && !hostName.trim().isEmpty()) {
            return hostName.trim();
        }
        return null;
    }

    @Nullable
    private String resolveAttribute(NsdServiceInfo serviceInfo, String key) {
        try {
            Map<String, byte[]> attributes = serviceInfo.getAttributes();
            if (attributes == null) {
                return null;
            }
            byte[] value = attributes.get(key);
            if (value == null || value.length == 0) {
                return null;
            }
            return new String(value).trim();
        } catch (Throwable ignored) {
            return null;
        }
    }
}
