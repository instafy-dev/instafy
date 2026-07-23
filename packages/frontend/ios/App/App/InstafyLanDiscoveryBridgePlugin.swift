import Foundation
import Capacitor
import Darwin

@objc(InstafyLanDiscoveryBridgePlugin)
public class InstafyLanDiscoveryBridgePlugin: CAPPlugin, CAPBridgedPlugin, NetServiceBrowserDelegate, NetServiceDelegate {
    public let identifier = "InstafyLanDiscoveryBridgePlugin"
    public let jsName = "InstafyLanDiscoveryBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise)
    ]

    private let eventName = "lanDiscovery"
    private let serviceType = "_instafy-speech._tcp."
    private let serviceDomain = "local."
    private var browser: NetServiceBrowser?
    private var state = "idle"
    private var lastError: String?
    private var services: [String: JSObject] = [:]
    private var serviceOrder: [String] = []
    private var updatedAt: String?

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(buildStatusPayload())
    }

    @objc func startDiscovery(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.browser != nil {
                self.state = "scanning"
                self.publishStatus()
                call.resolve(self.buildStatusPayload())
                return
            }

            let browser = NetServiceBrowser()
            browser.delegate = self
            self.browser = browser
            self.state = "scanning"
            self.lastError = nil
            self.touch()
            browser.searchForServices(ofType: self.serviceType, inDomain: self.serviceDomain)
            self.publishStatus()
            call.resolve(self.buildStatusPayload())
        }
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopDiscoveryInternal(clearServices: true)
            call.resolve(self.buildStatusPayload())
        }
    }

    public func netServiceBrowserWillSearch(_ browser: NetServiceBrowser) {
        state = "scanning"
        lastError = nil
        touch()
        publishStatus()
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
        state = "error"
        lastError = "Bonjour discovery failed (\(errorDict))."
        touch()
        publishStatus()
    }

    public func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
        if state != "error" {
            state = "idle"
        }
        touch()
        publishStatus()
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        let key = serviceKey(service)
        service.delegate = self
        if !serviceOrder.contains(key) {
            serviceOrder.append(key)
        }
        service.resolve(withTimeout: 5.0)
        if !moreComing {
            touch()
            publishStatus()
        }
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        let key = serviceKey(service)
        services.removeValue(forKey: key)
        serviceOrder.removeAll { $0 == key }
        if !moreComing {
            touch()
            publishStatus()
        }
    }

    public func netServiceDidResolveAddress(_ sender: NetService) {
        let key = serviceKey(sender)
        let payload = buildServicePayload(sender)
        services[key] = payload
        if !serviceOrder.contains(key) {
            serviceOrder.append(key)
        }
        touch()
        publishStatus()
    }

    public func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
        lastError = "Bonjour resolve failed for \(sender.name) (\(errorDict))."
        touch()
        publishStatus()
    }

    private func stopDiscoveryInternal(clearServices: Bool) {
        browser?.stop()
        browser = nil
        state = "idle"
        lastError = nil
        if clearServices {
            services.removeAll()
            serviceOrder.removeAll()
        }
        touch()
        publishStatus()
    }

    private func buildStatusPayload() -> JSObject {
        return [
            "snapshot": buildSnapshot()
        ]
    }

    private func buildSnapshot() -> JSObject {
        let orderedServices = serviceOrder.compactMap { services[$0] }
        var snapshot: JSObject = [
            "state": state,
            "services": orderedServices,
            "clientReachability": clientReachabilityMode()
        ]
        assignOptionalString(&snapshot, key: "lastError", value: lastError)
        assignOptionalString(&snapshot, key: "updatedAt", value: updatedAt)
        return snapshot
    }

    private func clientReachabilityMode() -> String {
        #if targetEnvironment(simulator)
        return "loopback"
        #else
        return "lan"
        #endif
    }

    private func publishStatus() {
        notifyListeners(eventName, data: buildStatusPayload(), retainUntilConsumed: true)
    }

    private func touch() {
        updatedAt = ISO8601DateFormatter().string(from: Date())
    }

    private func serviceKey(_ service: NetService) -> String {
        "\(service.name)|\(service.type)|\(service.domain)"
    }

    private func buildServicePayload(_ service: NetService) -> JSObject {
        let host = resolveHost(service)
        let txt = NetService.dictionary(fromTXTRecord: service.txtRecordData() ?? Data())
        let tokenHint = decodeTxt(txt["token_hint"])
        let hostMode = decodeTxt(txt["host_mode"])
        let authRequired = decodeTxt(txt["auth_required"]) == "1"
        let baseUrl: String?
        if let host, !host.isEmpty, service.port > 0 {
            baseUrl = "http://\(host):\(service.port)"
        } else {
            baseUrl = nil
        }
        var payload: JSObject = [
            "serviceName": service.name,
            "serviceType": service.type,
            "port": service.port > 0 ? service.port : NSNull(),
            "authRequired": authRequired,
            "updatedAt": ISO8601DateFormatter().string(from: Date())
        ]
        assignOptionalString(&payload, key: "host", value: host)
        assignOptionalString(&payload, key: "baseUrl", value: baseUrl)
        assignOptionalString(&payload, key: "tokenHint", value: tokenHint)
        assignOptionalString(&payload, key: "hostMode", value: hostMode)
        return payload
    }

    private func resolveHost(_ service: NetService) -> String? {
        if let addresses = service.addresses {
            let numericHosts = addresses.compactMap { addressData in
                addressData.withUnsafeBytes { pointer -> String? in
                    guard let sockaddrPointer = pointer.bindMemory(to: sockaddr.self).baseAddress else {
                        return nil
                    }
                    var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    let result = getnameinfo(
                        sockaddrPointer,
                        socklen_t(sockaddrPointer.pointee.sa_len),
                        &hostBuffer,
                        socklen_t(hostBuffer.count),
                        nil,
                        0,
                        NI_NUMERICHOST
                    )
                    guard result == 0 else {
                        return nil
                    }
                    let host = String(cString: hostBuffer).trimmingCharacters(in: .whitespacesAndNewlines)
                    return host.isEmpty ? nil : host
                }
            }

            if let ipv4Host = numericHosts.first(where: { $0.contains(".") }) {
                return ipv4Host
            }
            if let host = numericHosts.first {
                return host
            }
        }

        let hostName = service.hostName?.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard let hostName, !hostName.isEmpty else {
            return nil
        }
        return hostName
    }

    private func decodeTxt(_ value: Data?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return String(data: value, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func assignOptionalString(_ object: inout JSObject, key: String, value: String?) {
        if let value, !value.isEmpty {
            object[key] = value
            return
        }
        object[key] = NSNull()
    }
}
