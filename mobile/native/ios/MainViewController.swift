import UIKit
import Capacitor

/// Registers Toplix Pro's own native helper with the Capacitor bridge.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ToplixNativePlugin())
    }
}
