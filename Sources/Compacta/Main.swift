import AppKit
import SwiftUI

@main struct CompactaApplication: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
  var body: some Scene { SwiftUI.Settings { EmptyView() } }
}
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
  var model: AppModel!
  var window: NSWindow!
  var status: NSStatusItem!
  var popover: NSPopover!
  var statusAnimation: StatusIconAnimator?
  func applicationDidFinishLaunching(_ notification: Notification) {
    if Bootstrap.installIfNeeded() {
      NSApp.terminate(nil)
      return
    }
    NSApp.setActivationPolicy(.accessory)
    _ = Typeface.available
    model = AppModel()
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1040, height: 780),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "Compacta"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.backgroundColor = Neu.baseNS
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 840, height: 640)
    window.contentView = NSHostingView(rootView: CompactaRoot(model: model))
    window.center()
    window.setFrameAutosaveName("CompactaMainWindow")
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let b = status.button {
      b.image = StatusIcon.image()
      b.image?.accessibilityDescription = "Compacta"
      b.target = self
      b.action = #selector(toggleMenu)
      b.toolTip = "Compacta · compactación anticipada"
      statusAnimation = StatusIconAnimator(button: b, model: model)
    }
    popover = NSPopover()
    popover.behavior = .transient
    popover.animates = true
    popover.contentViewController = NSHostingController(
      rootView: MenuPanel(model: model, open: { [weak self] in self?.showWindow() }))
    let menu = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Acerca de Compacta",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Cerrar ventana", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    appMenu.addItem(
      withTitle: "Salir de Compacta", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    appItem.submenu = appMenu
    menu.addItem(appItem)
    let edit = NSMenuItem()
    let editMenu = NSMenu(title: "Edición")
    for (title, selector, key) in [
      ("Deshacer", "undo:", "z"), ("Cortar", "cut:", "x"), ("Copiar", "copy:", "c"),
      ("Pegar", "paste:", "v"), ("Seleccionar todo", "selectAll:", "a"),
    ] { editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key) }
    edit.submenu = editMenu
    menu.addItem(edit)
    NSApp.mainMenu = menu
    showWindow()
  }
  func showWindow() {
    popover?.performClose(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
  @objc func toggleMenu() {
    if popover.isShown {
      popover.performClose(nil)
    } else if let button = status.button {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      NSApp.activate(ignoringOtherApps: true)
    }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    showWindow()
    return true
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationWillTerminate(_ notification: Notification) {
    statusAnimation?.stop()
  }
}
