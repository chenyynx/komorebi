import SwiftUI

@main
struct KomorebiApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .preferredColorScheme(store.interfaceStyle.colorScheme)
        }
    }
}
