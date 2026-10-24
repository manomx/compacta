import AppKit
import Combine

/// Only the two arcs rotate; the central dot and the menu button stay still.
@MainActor final class StatusIconAnimator {
  private weak var button: NSStatusBarButton?
  private var observation: AnyCancellable?
  private var timer: Timer?
  private var frame = 0
  private let restingImage = StatusIcon.image()
  private lazy var frames: [NSImage] = (0..<48).map {
    StatusIcon.image(rotation: CGFloat($0) * 360 / 48)
  }

  init(button: NSStatusBarButton, model: AppModel) {
    self.button = button
    observation = Publishers.CombineLatest3(
      model.$snapshot, model.$connected, LanguageSettings.shared.$language
    )
      .receive(on: RunLoop.main)
      .sink { [weak self] snapshot, connected, _ in
        let jobs = snapshot?.codex.activeJobs ?? 0
        let busy = connected && jobs > 0
        let state: String
        if !connected {
          state = L("status.offline")
        } else if busy {
          state = L("status.preparingSummary")
        } else if snapshot?.config.paused == true {
          state = L("status.paused")
        } else if snapshot?.budgetReached == true {
          state = L("status.budget")
        } else {
          state = L("status.early")
        }
        self?.update(busy: busy, state: state)
      }
  }

  private func update(busy: Bool, state: String) {
    button?.toolTip = L("status.tooltip", state)
    button?.setAccessibilityLabel(L("status.tooltip", state))
    guard busy else {
      stop()
      return
    }
    guard timer == nil else { return }
    frame = 0
    button?.image = frames[frame]
    // Cached template images preserve macOS light/dark and selected-menu colors.
    // The timer exists only while the service reports real work, including with
    // the main window closed. Common mode also keeps it moving in the popover.
    let animation = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.frame = (self.frame + 1) % self.frames.count
        self.button?.image = self.frames[self.frame]
      }
    }
    animation.tolerance = 0.005
    timer = animation
    RunLoop.main.add(animation, forMode: .common)
  }

  func stop() {
    timer?.invalidate()
    timer = nil
    frame = 0
    button?.image = restingImage
  }
}
