import Foundation
import Capacitor

@objc(InstafySpeechHttpBridgePlugin)
public class InstafySpeechHttpBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "InstafySpeechHttpBridgePlugin"
    public let jsName = "InstafySpeechHttpBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "health", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "synthesize", returnType: CAPPluginReturnPromise)
    ]

    @objc func health(_ call: CAPPluginCall) {
        performRequest(call, method: "GET", expectsAudio: false)
    }

    @objc func transcribe(_ call: CAPPluginCall) {
        performRequest(call, method: "POST", expectsAudio: false)
    }

    @objc func synthesize(_ call: CAPPluginCall) {
        performRequest(call, method: "POST", expectsAudio: true)
    }

    private func performRequest(_ call: CAPPluginCall, method: String, expectsAudio: Bool) {
        guard let urlValue = call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !urlValue.isEmpty,
              let url = URL(string: urlValue) else {
            call.reject("Speech bridge requires a valid request url.")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if method != "GET" {
            let bodyJson = call.getString("bodyJson")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "{}"
            guard let bodyData = bodyJson.data(using: .utf8) else {
                call.reject("Speech bridge could not encode request JSON.")
                return
            }
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let authToken = call.getString("authToken")?.trimmingCharacters(in: .whitespacesAndNewlines),
           !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                DispatchQueue.main.async {
                    call.reject(error.localizedDescription)
                }
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                DispatchQueue.main.async {
                    call.reject("Speech bridge received an invalid response.")
                }
                return
            }

            let responseData = data ?? Data()
            let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type")?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()

            if !(200...299).contains(httpResponse.statusCode) {
                let detail = String(data: responseData, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let suffix = (detail?.isEmpty == false) ? ": \(detail!)" : ""
                DispatchQueue.main.async {
                    call.reject("Speech bridge request failed (\(httpResponse.statusCode))\(suffix)")
                }
                return
            }

            var payload: JSObject = [
                "statusCode": httpResponse.statusCode
            ]
            if let contentType, !contentType.isEmpty {
                payload["contentType"] = contentType
            } else {
                payload["contentType"] = NSNull()
            }

            if expectsAudio && (contentType?.hasPrefix("audio/") == true) {
                let mimeType = contentType ?? "application/octet-stream"
                payload["mimeType"] = mimeType
                payload["audioDataUrl"] = "data:\(mimeType);base64,\(responseData.base64EncodedString())"
                DispatchQueue.main.async {
                    call.resolve(payload)
                }
                return
            }

            if contentType?.contains("application/json") == true,
               let jsonString = String(data: responseData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !jsonString.isEmpty {
                payload["payloadJson"] = jsonString
                DispatchQueue.main.async {
                    call.resolve(payload)
                }
                return
            }

            let text = String(data: responseData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            payload["text"] = (text?.isEmpty == false) ? text : NSNull()
            DispatchQueue.main.async {
                call.resolve(payload)
            }
        }.resume()
    }
}
