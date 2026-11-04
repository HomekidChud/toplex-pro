import Foundation
import Capacitor
import Network
import Security
import UIKit
import SafariServices

/// Native helpers for Toplix Pro on iOS (same JavaScript API as the Android and desktop shells):
///  - loopback HTTP listener for the "Sign in with ChatGPT" redirect (127.0.0.1)
///  - HTTPS requests to OpenAI's auth/API hosts (the token endpoint is not CORS-enabled)
///  - credential storage in the iOS Keychain
///  - installed-or-not detection of the ChatGPT and Claude apps (nothing is read from them)
///  - links open in an in-app Safari sheet, which keeps the app in the foreground so the
///    local sign-in listener keeps running until the redirect arrives
@objc(ToplixNativePlugin)
public class ToplixNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ToplixNativePlugin"
    public let jsName = "ToplixNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "loopbackStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loopbackWait", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loopbackStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "http", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detectApps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "launchApp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)
    ]

    private static let httpHosts: Set<String> = ["auth.openai.com", "api.openai.com"]
    private static let keychainService = "com.homekidchud.toplexpro.secure"

    private let queue = DispatchQueue(label: "toplix.loopback")
    private var listener: NWListener?
    private var listenerPort: UInt16 = 0
    private var callbackUrl: String?
    private var waiting: CAPPluginCall?
    private weak var safari: SFSafariViewController?

    /* ---------------- Loopback listener ---------------- */

    @objc func loopbackStart(_ call: CAPPluginCall) {
        stopServer()
        let preferred = UInt16(call.getInt("port") ?? 1455)
        startListener(port: preferred, call: call, allowFallback: true)
    }

    private func startListener(port: UInt16?, call: CAPPluginCall, allowFallback: Bool) {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true

        let made: NWListener?
        if let port = port, let p = NWEndpoint.Port(rawValue: port) {
            made = try? NWListener(using: params, on: p)
        } else {
            made = try? NWListener(using: params)
        }
        guard let l = made else {
            if allowFallback { startListener(port: nil, call: call, allowFallback: false) }
            else { call.reject("Could not open a local sign-in listener") }
            return
        }

        var answered = false
        l.stateUpdateHandler = { [weak self, weak l] state in
            guard let self = self, let l = l else { return }
            switch state {
            case .ready:
                if answered { return }
                answered = true
                let actual = l.port?.rawValue ?? 0
                self.queue.async {
                    self.listener = l
                    self.listenerPort = actual
                    self.callbackUrl = nil
                }
                call.resolve(["port": Int(actual)])
            case .failed:
                l.cancel()
                if answered { return }
                answered = true
                if allowFallback { self.startListener(port: nil, call: call, allowFallback: false) }
                else { call.reject("Could not open a local sign-in listener") }
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        l.start(queue: queue)
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, _, _ in
            guard let self = self, let data = data, let text = String(data: data, encoding: .utf8) else {
                conn.cancel()
                return
            }
            let first = text.components(separatedBy: "\r\n").first ?? ""
            let parts = first.split(separator: " ")
            let target = parts.count > 1 ? String(parts[1]) : "/"
            if target.hasPrefix("/auth/callback") {
                let html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                    + "<title>Toplix Pro</title><body style='font:16px -apple-system,system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f7f7f8;color:#111827'>"
                    + "<div style='text-align:center;padding:24px'><h2>Almost done</h2><p>Return to Toplix Pro to continue.</p>"
                    + "<p><a href='toplex://auth/done' style='display:inline-block;padding:12px 20px;border-radius:10px;background:#111827;color:#fff;text-decoration:none'>Open Toplix Pro</a></p></div></body>"
                self.respond(conn, status: "200 OK", body: html)
                let url = "http://127.0.0.1:\(self.listenerPort)\(target)"
                self.deliver(url)
            } else {
                self.respond(conn, status: "404 Not Found", body: "")
            }
        }
    }

    private func respond(_ conn: NWConnection, status: String, body: String) {
        let bytes = Data(body.utf8)
        let head = "HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(bytes)
        conn.send(content: out, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed({ _ in conn.cancel() }))
    }

    private func deliver(_ url: String) {
        queue.async {
            self.callbackUrl = url
            if let c = self.waiting {
                self.waiting = nil
                c.resolve(["url": url])
                self.bridge?.releaseCall(c)
            }
            self.listener?.cancel()
            self.listener = nil
            DispatchQueue.main.async { self.safari?.dismiss(animated: true) }
        }
    }

    @objc func loopbackWait(_ call: CAPPluginCall) {
        queue.async {
            if let url = self.callbackUrl {
                call.resolve(["url": url])
                return
            }
            if self.listener == nil {
                call.reject("No sign-in in progress")
                return
            }
            self.bridge?.saveCall(call)
            self.waiting = call
        }
    }

    @objc func loopbackStop(_ call: CAPPluginCall) {
        stopServer()
        DispatchQueue.main.async { self.safari?.dismiss(animated: true) }
        call.resolve()
    }

    private func stopServer() {
        queue.sync {
            listener?.cancel()
            listener = nil
            callbackUrl = nil
            if let c = waiting {
                waiting = nil
                c.reject("Sign-in cancelled")
                bridge?.releaseCall(c)
            }
        }
    }

    /* ---------------- HTTP ---------------- */

    @objc func http(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              url.scheme == "https", let host = url.host, ToplixNativePlugin.httpHosts.contains(host) else {
            call.reject("Host not allowed")
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = call.getString("method") ?? "GET"
        req.timeoutInterval = 30
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if let headers = call.getObject("headers") {
            for (k, v) in headers {
                if let s = v as? String { req.setValue(s, forHTTPHeaderField: k) }
            }
        }
        if let body = call.getString("body") { req.httpBody = Data(body.utf8) }
        send(req, host: host, attempt: 0, call: call)
    }

    private func send(_ req: URLRequest, host: String, attempt: Int, call: CAPPluginCall) {
        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            if let error = error as? URLError {
                // Only failures that happen before the request is sent are retried, so a
                // one-time sign-in code is never submitted twice.
                let beforeSend: Set<URLError.Code> = [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .notConnectedToInternet]
                if beforeSend.contains(error.code) && attempt < 2 {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.8 * Double(attempt + 1)) {
                        self?.send(req, host: host, attempt: attempt + 1, call: call)
                    }
                    return
                }
                call.reject("Could not reach \(host). Check that this device is online and that no VPN, private DNS or ad blocker is blocking it. (\(error.localizedDescription))")
                return
            }
            if let error = error {
                call.reject("Network error: \(error.localizedDescription)")
                return
            }
            guard let http = response as? HTTPURLResponse else {
                call.reject("Network error: no response")
                return
            }
            var result: [String: Any] = [
                "status": http.statusCode,
                "text": String(data: data ?? Data(), encoding: .utf8) ?? ""
            ]
            if let date = http.value(forHTTPHeaderField: "Date") { result["date"] = date }
            call.resolve(result)
        }.resume()
    }

    /* ---------------- Secure storage (Keychain) ---------------- */

    private func keychainQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: ToplixNativePlugin.keychainService,
            kSecAttrAccount as String: key
        ]
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("Missing key"); return }
        let value = call.getString("value") ?? ""
        SecItemDelete(keychainQuery(key) as CFDictionary)
        var q = keychainQuery(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecSuccess { call.resolve() }
        else { call.reject("Secure storage failed (code \(status))") }
    }

    @objc func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.resolve(["value": NSNull()]); return }
        var q = keychainQuery(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, let s = String(data: data, encoding: .utf8) {
            call.resolve(["value": s])
        } else {
            call.resolve(["value": NSNull()])
        }
    }

    @objc func secureRemove(_ call: CAPPluginCall) {
        if let key = call.getString("key") { SecItemDelete(keychainQuery(key) as CFDictionary) }
        call.resolve()
    }

    /* ---------------- Apps + browser ---------------- */

    private static let appSchemes: [String: String] = ["chatgpt": "chatgpt://", "claude": "claude://"]

    @objc func detectApps(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var result: [String: Any] = [:]
            for (name, scheme) in ToplixNativePlugin.appSchemes {
                if let u = URL(string: scheme) { result[name] = UIApplication.shared.canOpenURL(u) } else { result[name] = false }
            }
            call.resolve(result)
        }
    }

    @objc func launchApp(_ call: CAPPluginCall) {
        guard let app = call.getString("app"), let scheme = ToplixNativePlugin.appSchemes[app], let u = URL(string: scheme) else {
            call.reject("Unknown app")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(u, options: [:]) { ok in
                if ok { call.resolve() } else { call.reject("That app is not installed") }
            }
        }
    }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let u = URL(string: s), u.scheme == "https" else {
            call.reject("Only https links can be opened")
            return
        }
        DispatchQueue.main.async {
            guard var top = self.bridge?.viewController else {
                UIApplication.shared.open(u, options: [:], completionHandler: nil)
                call.resolve()
                return
            }
            while let next = top.presentedViewController { top = next }
            let vc = SFSafariViewController(url: u)
            self.safari = vc
            top.present(vc, animated: true) { call.resolve() }
        }
    }
}
