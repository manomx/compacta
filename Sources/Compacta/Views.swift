import AppKit
import Charts
import SwiftUI

struct StatusPill: View {
  @ObservedObject var model: AppModel
  var body: some View {
    HStack(spacing: 8) {
      StatusLED(on: model.connected && model.snapshot?.config.paused != true)
      Text(model.statusTitle).font(jf(12, .semibold)).foregroundStyle(Neu.text)
    }
  }
}

// MARK: - Raíz

struct CompactaRoot: View {
  @ObservedObject var model: AppModel
  var body: some View {
    Group {
      if let s = model.snapshot {
        if !s.config.onboarded {
          OnboardingView(model: model)
        } else {
          HStack(spacing: 16) {
            sidebar
            VStack(spacing: 0) {
              toolbar
              ScrollView {
                Group {
                  switch model.page {
                  case .overview: OverviewView(model: model)
                  case .compaction: CompactionView(model: model)
                  case .providers: ProvidersView(model: model)
                  case .activity: ActivityView(model: model)
                  case .settings: PreferencesView(model: model)
                  }
                }
                .id(model.page)
                .transition(.opacity.combined(with: .offset(y: 10)))
                .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 34)
                .frame(maxWidth: 1080)
                .frame(maxWidth: .infinity)
              }
              .scrollIndicators(.never)
              .animation(Neu.softSpring, value: model.page)
            }
            .overlay(alignment: .bottom) {
              if model.dirty {
                saveBar.transition(.move(edge: .bottom).combined(with: .opacity))
              }
            }
            .animation(Neu.spring, value: model.dirty)
          }
          .padding(14)
        }
      } else {
        loading
      }
    }
    .font(jf(13)).foregroundStyle(Neu.text)
    .frame(minWidth: 840, minHeight: 620)
    .background(Neu.base.ignoresSafeArea())
    .tint(Neu.accent)
    .overlay(alignment: .top) {
      if let notice = model.notice {
        HStack(spacing: 10) {
          Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
            .foregroundStyle(Neu.accent).frame(width: 22, height: 22)
            .neuInset(Circle(), depth: 2)
          Text(notice).font(jf(13, .semibold))
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .neuRaised(Capsule(), depth: 7)
        .padding(.top, 18)
        .transition(.move(edge: .top).combined(with: .opacity))
        .allowsHitTesting(false)
      }
    }
    .animation(Neu.spring, value: model.notice)
    .alert(
      "No se pudo completar",
      isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })
    ) {
      Button("Entendido", role: .cancel) { model.error = nil }
    } message: {
      Text(model.error ?? "")
    }
    .onAppear { applyAppearance(model.draft?.appearance) }
    .onChange(of: model.snapshot?.config.appearance) { _, v in applyAppearance(v) }
  }

  func applyAppearance(_ value: String?) {
    NSApp.appearance =
      value == "dark"
      ? NSAppearance(named: .darkAqua) : value == "light" ? NSAppearance(named: .aqua) : nil
  }

  var loading: some View {
    VStack(spacing: 22) {
      ZStack {
        Circle().fill(Color.clear).frame(width: 150, height: 150).neuRaised(Circle(), depth: 10)
        Circle().fill(Color.clear).frame(width: 112, height: 112).neuInset(Circle(), depth: 5)
        LogoMark(size: 58, live: model.working)
      }
      Text("Compacta").font(jf(30, .bold))
      if model.working {
        Text("Preparando tu espacio…").font(jf(14)).foregroundStyle(Neu.text2)
      } else {
        Text("No pudimos iniciar el servicio.").font(jf(14)).foregroundStyle(Neu.text2)
        HStack(spacing: 14) {
          Button("Abrir diagnóstico") { model.openLogs() }.buttonStyle(.neu)
          Button("Intentar de nuevo") { Task { await model.connect() } }.buttonStyle(.neuProminent)
        }
      }
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  var sidebar: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 12) {
        LogoMark(size: 24).frame(width: 42, height: 42).neuRaised(radius: 14, depth: 4)
        VStack(alignment: .leading, spacing: 2) {
          Text("Compacta").font(jf(15, .bold))
          Text("Espacio para seguir").font(jf(11)).foregroundStyle(Neu.text2)
        }
      }
      .padding(.horizontal, 4).padding(.top, 44).padding(.bottom, 22)
      ForEach(Page.allCases) { page in
        let on = model.page == page
        Button {
          withAnimation(Neu.spring) { model.page = page }
        } label: {
          HStack(spacing: 12) {
            Image(systemName: page.symbol).font(.system(size: 13, weight: .semibold))
              .foregroundStyle(on ? Neu.accent : Neu.text2)
              .frame(width: 28, height: 28)
              .background {
                if on { Color.clear.neuInset(radius: 9, depth: 2) }
              }
            Text(page.rawValue).font(jf(13, on ? .semibold : .medium))
              .foregroundStyle(on ? Neu.text : Neu.text2)
            Spacer()
          }
          .padding(.horizontal, 10).frame(height: 44)
          .background {
            if on { Color.clear.neuRaised(radius: 14, depth: 5) }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier("nav-\(page.id)")
      }
      Spacer()
      VStack(alignment: .leading, spacing: 8) {
        StatusPill(model: model)
        Text("Todo se gestiona en tu Mac · v\(model.snapshot?.version ?? "1.0.1")").font(jf(10.5))
          .foregroundStyle(Neu.text2)
      }
      .padding(14).frame(maxWidth: .infinity, alignment: .leading)
      .neuRaised(radius: 18, depth: 4)
    }
    .padding(.horizontal, 14).padding(.bottom, 16)
    .frame(width: 230).frame(maxHeight: .infinity)
    .neuInset(radius: 24, depth: 5)
  }

  var toolbar: some View {
    HStack {
      Text("Compacta / \(model.page.rawValue)").font(jf(12, .medium)).foregroundStyle(Neu.text2)
        .contentTransition(.opacity)
      Spacer()
      if model.working { ProgressView().controlSize(.small).padding(.trailing, 6) }
      let paused = model.snapshot?.config.paused == true
      Button {
        Task { await model.setPaused(!paused) }
      } label: {
        Label(paused ? "Reanudar" : "Pausar", systemImage: paused ? "play.fill" : "pause.fill")
      }
      .buttonStyle(NeuButtonStyle()).disabled(model.working)
    }
    .padding(.leading, 18).padding(.trailing, 18).frame(height: 58)
  }

  var saveBar: some View {
    HStack(spacing: 12) {
      Circle().fill(Neu.accent).frame(width: 7, height: 7)
      Text("Tienes cambios sin guardar").font(jf(12.5, .medium)).foregroundStyle(Neu.text2)
      Spacer()
      Button("Descartar") { model.draft = model.snapshot?.config }.buttonStyle(.neu)
      Button("Guardar cambios") { Task { await model.save() } }.buttonStyle(.neuProminent)
        .keyboardShortcut("s", modifiers: .command).disabled(model.working)
    }
    .padding(.horizontal, 18).padding(.vertical, 12)
    .neuRaised(radius: 20, depth: 8)
    .padding(.horizontal, 18).padding(.bottom, 8)
  }
}

/// Encabezado de página (todas menos Resumen, que tiene su propio héroe).
struct PageHeader: View {
  var page: Page
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(page.rawValue).font(jf(30, .bold)).kerning(-0.8)
      Text(page.subtitle).font(jf(13.5)).foregroundStyle(Neu.text2)
    }.padding(.horizontal, 4).padding(.bottom, 6).reveal(0)
  }
}

// MARK: - Bienvenida

struct OnboardingView: View {
  @ObservedObject var model: AppModel
  @State var codex = true
  @State var claude = true
  var body: some View {
    VStack(spacing: 28) {
      Spacer()
      ZStack {
        Circle().fill(Color.clear).frame(width: 140, height: 140).neuRaised(Circle(), depth: 10)
        Circle().fill(Color.clear).frame(width: 104, height: 104).neuInset(Circle(), depth: 5)
        LogoMark(size: 54, live: true)
      }.reveal(0)
      VStack(spacing: 10) {
        Text("Espacio para seguir.").font(jf(36, .bold)).kerning(-1)
        Text("Compacta prepara tus conversaciones en segundo plano.\nElige dónde quieres usarlo.")
          .font(jf(15)).foregroundStyle(Neu.text2).multilineTextAlignment(.center).lineSpacing(4)
      }.reveal(1)
      HStack(spacing: 22) {
        client(
          "Codex", id: "codex", subtitle: "Tu sesión de ChatGPT", selected: $codex,
          detected: model.snapshot?.integration.codex.detected ?? false)
        client(
          "Claude Code", id: "claude", subtitle: "Tu sesión de Claude", selected: $claude,
          detected: model.snapshot?.integration.claude.detected ?? false)
      }.frame(maxWidth: 580).reveal(2)
      VStack(spacing: 14) {
        Button {
          Task { await model.activate(codex: codex, claude: claude) }
        } label: {
          HStack(spacing: 8) {
            if model.working { ProgressView().controlSize(.small) }
            Text("Activar Compacta")
            Image(systemName: "arrow.right")
          }.frame(width: 230)
        }.buttonStyle(.neuProminent).disabled(model.working || (!codex && !claude))
        Button("Configurar primero") {
          model.draft?.onboarded = true
          Task { await model.save() }
        }.buttonStyle(.plain).font(jf(12.5, .medium)).foregroundStyle(Neu.text2)
      }.reveal(3)
      Text("Usa tus cuentas existentes. Puedes cambiarlo o desactivarlo cuando quieras.")
        .font(jf(11.5)).foregroundStyle(Neu.text2)
      Spacer()
      HStack(spacing: 26) {
        Label("Claves en el Llavero", systemImage: "lock")
        Label("Instalación por usuario", systemImage: "person.crop.circle")
        Label("Sin reiniciar Codex", systemImage: "bolt")
      }.font(jf(11.5)).foregroundStyle(Neu.text2).padding(.bottom, 26)
    }.padding(36).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
  func client(
    _ name: String, id: String, subtitle: String, selected: Binding<Bool>, detected: Bool
  ) -> some View {
    let on = selected.wrappedValue
    return Button {
      withAnimation(Neu.spring) { selected.wrappedValue.toggle() }
    } label: {
      VStack(alignment: .leading, spacing: 16) {
        HStack {
          ClientIcon(client: id, size: 44)
          Spacer()
          Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy))
            .foregroundStyle(on ? Color.white : Color.clear)
            .frame(width: 26, height: 26)
            .background {
              if on { Circle().fill(Neu.fill) } else { Color.clear.neuInset(Circle(), depth: 2) }
            }
        }
        VStack(alignment: .leading, spacing: 5) {
          Text(name).font(jf(17, .bold))
          Text(subtitle).font(jf(12)).foregroundStyle(Neu.text2)
          Text(detected ? "Detectado en tu Mac" : "Se conectará al instalar el cliente")
            .font(jf(10.5, .medium)).foregroundStyle(detected ? Neu.accent : Neu.text3)
        }
      }
      .padding(22).frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if on {
          Color.clear.neuRaised(radius: 24, depth: 8)
        } else {
          Color.clear.neuInset(radius: 24, depth: 4)
        }
      }
      .contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel("Seleccionar \(name)")
  }
}

// MARK: - Resumen

struct OverviewView: View {
  @ObservedObject var model: AppModel
  @State var orbit = false
  var body: some View {
    if let s = model.snapshot {
      VStack(alignment: .leading, spacing: 30) {
        hero(s).reveal(0)
        VStack(alignment: .leading, spacing: 16) {
          SectionTitle(title: "Consumo observado") {
            NeuSegmented(
              selection: $model.period, options: [(1, "Hoy"), (7, "7 días"), (30, "30 días")]
            )
            .onChange(of: model.period) { _, _ in Task { await model.refresh() } }
          }
          HStack(alignment: .top, spacing: 22) {
            metricInput(s).frame(minWidth: 0, maxWidth: .infinity)
            metricOutput(s).frame(minWidth: 0, maxWidth: .infinity)
            metricCost(s).frame(minWidth: 0, maxWidth: .infinity)
          }
        }.reveal(1)
        VStack(alignment: .leading, spacing: 16) {
          SectionTitle(title: "Tus límites") {
            Button {
              Task { await model.refreshQuotas() }
            } label: {
              Label("Actualizar", systemImage: "arrow.clockwise")
            }.buttonStyle(LinkButtonStyle()).disabled(model.working)
          }
          HStack(alignment: .top, spacing: 22) {
            QuotaCard(model: model, client: "codex", name: "Codex")
            QuotaCard(model: model, client: "claude", name: "Claude Code")
          }
        }.reveal(2)
        VStack(alignment: .leading, spacing: 16) {
          SectionTitle("Conexiones")
          VStack(spacing: 8) {
            integrationRow(
              "codex", "Codex", active: s.integration.codex.active, note: s.integration.codex.note
            ) { v in
              Task { await model.activate(codex: v, claude: s.integration.claude.active) }
            }
            integrationRow(
              "claude", "Claude Code", active: s.integration.claude.active,
              note: s.integration.claude.note
            ) { v in
              Task { await model.activate(codex: s.integration.codex.active, claude: v) }
            }
          }
          .padding(10).neuRaised(radius: 26, depth: 8)
        }.reveal(3)
        Text(
          "Las métricas cubren el tráfico que pasa por Compacta desde su activación. Los límites de suscripción vienen directamente de cada cuenta."
        ).font(jf(11.5)).foregroundStyle(Neu.text3).lineSpacing(3).padding(.horizontal, 4).reveal(4)
      }
    }
  }

  func hero(_ s: Snapshot) -> some View {
    let paused = s.config.paused
    return HStack(spacing: 24) {
      VStack(alignment: .leading, spacing: 10) {
        Text(
          paused ? "En pausa" : model.jobs > 0 ? "Preparando ahora" : "Preparando en segundo plano"
        )
        .font(jf(12, .semibold)).foregroundStyle(Neu.accent)
        Group {
          if paused {
            Text("Un momento\n") + Text("de pausa.").foregroundColor(Neu.text3)
          } else if model.jobs > 0 {
            Text("Preparando\n") + Text("el próximo paso.").foregroundColor(Neu.text3)
          } else {
            Text("Tu contexto,\n") + Text("bajo control.").foregroundColor(Neu.text3)
          }
        }
        .font(jf(36, .bold)).kerning(-1.1).lineSpacing(-2)
        .contentTransition(.opacity)
        Text(
          paused
            ? "Tus conversaciones continúan. No iniciamos nuevos resúmenes."
            : "Los resúmenes se preparan mientras sigues trabajando. Nada se interrumpe."
        ).font(jf(14.5)).foregroundStyle(Neu.text2).lineSpacing(3).frame(
          maxWidth: 440, alignment: .leading)
      }
      .animation(Neu.softSpring, value: paused)
      Spacer()
      ZStack {
        Circle().fill(Color.clear).frame(width: 140, height: 140).neuRaised(Circle(), depth: 8)
        Circle().fill(Neu.accent).frame(width: 8, height: 8).shadow(color: Neu.accent, radius: 5)
          .offset(y: -61).rotationEffect(.degrees(orbit ? 360 : 0))
          .opacity(paused ? 0.25 : 1)
          .animation(
            paused ? .default : .linear(duration: 6).repeatForever(autoreverses: false),
            value: orbit)
        Circle().fill(Color.clear).frame(width: 104, height: 104).neuInset(Circle(), depth: 5)
        LogoMark(size: 34, live: true, paused: paused)
          .frame(width: 64, height: 64)
          .neuRaised(Circle(), depth: paused ? 2 : 4)
          .scaleEffect(paused ? 0.93 : 1)
          .animation(Neu.spring, value: paused)
      }
      .onAppear { orbit = true }
      .onChange(of: paused) { _, p in orbit = !p }
    }
    .padding(.horizontal, 30).padding(.vertical, 26)
    .neuRaised(radius: 28, depth: 9)
  }

  func metricCard<Extra: View>(
    _ title: String, value: String, caption: String, chip: String? = nil,
    @ViewBuilder extra: () -> Extra
  ) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(title).font(jf(12.5, .semibold)).foregroundStyle(Neu.text2)
        Spacer()
        if let chip { Chip(text: chip, color: Neu.deep) }
      }.frame(height: 24)
      Text(value).font(jf(32, .bold)).kerning(-1).monospacedDigit().padding(.top, 12)
        .contentTransition(.numericText()).lineLimit(1).minimumScaleFactor(0.6)
      Text(caption).font(jf(12)).foregroundStyle(Neu.text2).padding(.top, 6).lineLimit(2)
      extra().padding(.top, 14)
    }
    .padding(22).frame(maxWidth: .infinity, alignment: .leading)
    .neuRaised(radius: 26, depth: 8)
    .animation(Neu.softSpring, value: value)
  }

  func metricInput(_ s: Snapshot) -> some View {
    let pct =
      s.usage.input > 0 ? Int((Double(s.usage.cached) / Double(s.usage.input) * 100).rounded()) : 0
    return metricCard(
      "Entrada", value: s.usage.input.compact, caption: "\(s.usage.cached.compact) desde caché",
      chip: pct > 0 ? "\(pct) % caché" : nil
    ) {
      ChartWell { Sparkline(values: s.usage.chart.map { Double($0.input) }) }
    }
  }
  func metricOutput(_ s: Snapshot) -> some View {
    metricCard(
      "Salida", value: s.usage.output.compact, caption: "\(s.usage.requests) solicitudes observadas"
    ) {
      ChartWell { MiniBars(values: s.usage.chart.map { Double($0.output) }) }
    }
  }
  func metricCost(_ s: Snapshot) -> some View {
    let budget = s.config.dailyBudget
    return metricCard(
      "Costo API equivalente", value: currency(s.usage.cost),
      caption: s.usage.unpriced > 0
        ? "\(s.usage.unpriced) solicitudes sin tarifa" : "Estimación en USD · no es tu factura"
    ) {
      VStack(alignment: .leading, spacing: 10) {
        if budget > 0 {
          NeuProgress(value: s.usage.cost / budget, warning: s.budgetReached, height: 14)
          Text(
            s.budgetReached
              ? "Límite diario alcanzado"
              : "\(Int((s.usage.cost / budget * 100).rounded())) % del límite diario"
          ).font(jf(11.5)).foregroundStyle(s.budgetReached ? Neu.warn : Neu.text2)
        } else {
          NeuProgress(value: 0, height: 14)
          Text("Sin límite diario de costo").font(jf(11.5)).foregroundStyle(Neu.text2)
        }
      }.frame(height: 72, alignment: .top)
    }
  }

  func integrationRow(
    _ id: String, _ title: String, active: Bool, note: String, change: @escaping (Bool) -> Void
  ) -> some View {
    HStack(spacing: 14) {
      ClientIcon(client: id)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(jf(13.5, .semibold))
        Text(note.isEmpty ? (active ? "Conectado" : "Desactivado") : note).font(jf(12))
          .foregroundStyle(Neu.text2).fixedSize(horizontal: false, vertical: true)
      }
      Toggle(title, isOn: Binding(get: { active }, set: change)).labelsHidden().toggleStyle(.neu)
        .disabled(model.working)
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
  }
}

struct QuotaCard: View {
  @ObservedObject var model: AppModel
  var client: String
  var name: String
  var body: some View {
    let q = model.snapshot?.quotas[client]
    VStack(alignment: .leading, spacing: 20) {
      HStack(spacing: 12) {
        ClientIcon(client: client)
        VStack(alignment: .leading, spacing: 2) {
          Text(name).font(jf(15, .bold))
          if let q, q.stale {
            Text("Último dato disponible").font(jf(11.5)).foregroundStyle(Neu.warn)
          } else if let at = q?.fetchedAt, let d = parsedDate(at) {
            Text("Actualizado \(d.formatted(.relative(presentation: .named)))").font(jf(11.5))
              .foregroundStyle(Neu.text2)
          } else {
            Text("Consultando tu cuenta…").font(jf(11.5)).foregroundStyle(Neu.text2)
          }
        }
        Spacer()
        if let q, !q.plan.isEmpty { Chip(text: q.plan.capitalized) }
      }
      if let q, q.available, !q.limits.isEmpty {
        let main = q.limits.max(by: { $0.usedPercent < $1.usedPercent })!
        HStack(spacing: 22) {
          NeuGauge(percent: main.usedPercent, warning: main.usedPercent >= 85)
          VStack(alignment: .leading, spacing: 14) {
            ForEach(q.limits.prefix(3)) { limit in
              VStack(alignment: .leading, spacing: 7) {
                HStack {
                  Text(limit.label).font(jf(12.5, .medium))
                  Spacer()
                  Text("\(limit.usedPercent, specifier: "%.0f") %").font(jf(12, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(limit.usedPercent >= 85 ? Neu.warn : Neu.text2)
                }
                NeuProgress(value: limit.usedPercent / 100, warning: limit.usedPercent >= 85)
                Text(relativeReset(limit.resetsAt)).font(jf(11)).foregroundStyle(Neu.text3)
              }
            }
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 12) {
          Text("Límites no disponibles").font(jf(13.5, .semibold))
          Text(q?.error ?? "Consultando tu cuenta…").font(jf(12)).foregroundStyle(Neu.text2)
            .fixedSize(horizontal: false, vertical: true)
          Button("Abrir \(name)") { model.openClient(client) }.buttonStyle(.neuCompact)
        }
      }
    }
    .padding(22).frame(maxWidth: .infinity, alignment: .leading)
    .neuRaised(radius: 26, depth: 8)
  }
}

// MARK: - Compactación

struct CompactionView: View {
  @ObservedObject var model: AppModel
  @State var client = "codex"
  @State var advanced = false
  var policy: Binding<Policy> {
    Binding(
      get: { client == "codex" ? model.draft!.codex : model.draft!.claude },
      set: { if client == "codex" { model.draft?.codex = $0 } else { model.draft?.claude = $0 } })
  }
  var body: some View {
    if let settings = model.draft {
      VStack(alignment: .leading, spacing: 26) {
        HStack(alignment: .bottom) {
          PageHeader(page: .compaction)
          Spacer()
          NeuSegmented(
            selection: $client, options: [("codex", "Codex"), ("claude", "Claude Code")]
          )
          .padding(.bottom, 10)
        }
        Panel(
          title: "Cuándo preparar",
          subtitle: "Anticipamos el trabajo para reducir la espera de compactación."
        ) {
          NeuSegmented(
            selection: policy.mode,
            options: [("continuous", "Continuamente"), ("threshold", "A partir de un porcentaje")],
            stretch: true)
          if policy.wrappedValue.mode == "threshold" {
            VStack(alignment: .leading, spacing: 12) {
              HStack(alignment: .firstTextBaseline) {
                Text("Comenzar al").font(jf(13.5))
                Spacer()
                Text("\(policy.wrappedValue.thresholdPercent)").font(jf(40, .bold)).kerning(-1.2)
                  .foregroundStyle(Neu.accent).monospacedDigit()
                  .contentTransition(
                    .numericText(value: Double(policy.wrappedValue.thresholdPercent)))
                Text("%").font(jf(18, .semibold)).foregroundStyle(Neu.text2)
              }
              NeuSlider(
                value: Binding(
                  get: { Double(policy.wrappedValue.thresholdPercent) },
                  set: { policy.wrappedValue.thresholdPercent = Int($0) }), range: 1...95)
              HStack {
                Text("Más anticipación")
                Spacer()
                Text("Menos preparaciones")
              }.font(jf(11)).foregroundStyle(Neu.text3)
            }.transition(.opacity.combined(with: .move(edge: .top)))
          } else {
            Label(
              client == "codex"
                ? "Actualiza el resumen después de cada respuesta terminada."
                : "Prepara después de cada cambio. Puede consumir más tokens.",
              systemImage: "bolt.fill"
            )
            .font(jf(12.5)).foregroundStyle(Neu.text2)
          }
          divider
          HStack {
            Text("Ventana de contexto").font(jf(13))
            Spacer()
            TextField("Tokens", value: policy.contextWindow, format: .number).neuField(width: 140)
            Text("tokens").font(jf(12)).foregroundStyle(Neu.text2)
          }
          Text(
            client == "codex"
              ? "Este porcentaje controla la preparación. Codex aplica el resumen cuando solicita compactar."
              : "Cuando se alcance este porcentaje, el historial preparado se usa en las próximas solicitudes."
          ).font(jf(11.5)).foregroundStyle(Neu.text2)
        }
        .animation(Neu.spring, value: policy.wrappedValue.mode)
        .reveal(1)

        Panel(title: "Quién prepara el resumen") {
          HStack {
            Text("Cuenta o API").font(jf(13))
            Spacer()
            NeuMenu(
              selection: policy.providerID, options: settings.providers.map { ($0.id, $0.name) },
              width: 260)
          }
          .onChange(of: policy.wrappedValue.providerID) { _, id in
            if let provider = settings.providers.first(where: { $0.id == id }) {
              policy.wrappedValue.model = provider.model
              policy.wrappedValue.contextWindow = provider.contextWindow
            }
          }
          HStack(spacing: 10) {
            Text("Modelo del resumen").font(jf(13))
            Spacer()
            TextField("Identificador del modelo", text: policy.model).neuField(
              width: 260, mono: true)
            Menu {
              ForEach(model.snapshot?.modelSuggestions ?? [], id: \.self) { name in
                Button(name) { policy.wrappedValue.model = name }
              }
            } label: {
              Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
                .foregroundStyle(Neu.accent).frame(width: 34, height: 34)
                .neuRaised(radius: 11, depth: 3.5)
            }.menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
          }
          if client == "codex" {
            HStack {
              Text("Esfuerzo").font(jf(13))
              Spacer()
              NeuSegmented(
                selection: policy.effort,
                options: [("low", "Bajo"), ("medium", "Medio"), ("high", "Alto")])
            }
            if settings.providers.first(where: { $0.id == policy.wrappedValue.providerID })?.auth
              != "codex"
            {
              Label(
                "El resumen externo se convierte al formato nativo de Codex. Ambos pasos aparecen en el consumo.",
                systemImage: "info.circle"
              ).font(jf(11.5)).foregroundStyle(Neu.text2)
            }
          }
          Text(
            "El modelo de tu conversación sigue siendo el elegido dentro de \(client == "codex" ? "Codex" : "Claude Code")."
          ).font(jf(11.5)).foregroundStyle(Neu.text2)
        }.reveal(2)

        Panel(title: "Ritmo y conservación") {
          NeuStepper(
            title: policy.wrappedValue.maxConcurrent == 0
              ? "Preparaciones simultáneas: Sin límite"
              : "Preparaciones simultáneas: \(policy.wrappedValue.maxConcurrent)",
            value: policy.maxConcurrent, range: (client == "codex" ? 0 : 1)...4)
          NeuStepper(
            title: "Intervalo mínimo: \(policy.wrappedValue.cooldownSeconds) s",
            value: policy.cooldownSeconds, range: 0...3600, step: 5)
          HStack {
            Text("Cambios mínimos entre resúmenes").font(jf(13))
            Spacer()
            TextField("Tokens", value: policy.minDeltaTokens, format: .number).neuField(width: 110)
          }
          if client == "claude" {
            NeuStepper(
              title: "Mensajes recientes completos: \(policy.wrappedValue.keepRecent)",
              value: policy.keepRecent, range: 2...40)
          }
          divider
          Button {
            withAnimation(Neu.spring) { advanced.toggle() }
          } label: {
            HStack {
              Text("Instrucciones y límites avanzados").font(jf(13, .semibold))
              Spacer()
              Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold))
                .foregroundStyle(Neu.accent).rotationEffect(.degrees(advanced ? 90 : 0))
                .frame(width: 28, height: 28).neuRaised(Circle(), depth: 3)
            }.contentShape(Rectangle())
          }.buttonStyle(.plain)
          if advanced {
            VStack(alignment: .leading, spacing: 14) {
              HStack {
                Text("Máximo del resumen por API").font(jf(13))
                Spacer()
                TextField("Tokens", value: policy.summaryTokens, format: .number).neuField(
                  width: 110)
              }
              Text("Qué debe conservar el resumen").font(jf(13, .semibold))
              TextEditor(text: policy.instructions).font(jf(12.5)).scrollContentBackground(.hidden)
                .frame(minHeight: 150).padding(10).neuInset(radius: 16, depth: 3)
              Text(
                "Aplicable al resumidor externo. El formato nativo de Codex tiene sus propios límites."
              ).font(jf(11)).foregroundStyle(Neu.text2)
            }.transition(.opacity.combined(with: .move(edge: .top)))
          }
        }.reveal(3)

        if let engine = client == "codex" ? model.snapshot?.codex : model.snapshot?.claude {
          Panel(title: "Preparación actual") {
            HStack(spacing: 16) {
              smallMetric("Resúmenes", engine.prepared)
              smallMetric("Aplicados", engine.fastCompactions)
              smallMetric("En proceso", engine.activeJobs)
            }
            if engine.sessions.isEmpty {
              Text("Las sesiones aparecerán cuando empieces a trabajar.").font(jf(12.5))
                .foregroundStyle(Neu.text2)
            } else {
              VStack(spacing: 4) {
                ForEach(engine.sessions.prefix(8)) { s in
                  HStack(spacing: 12) {
                    Image(
                      systemName: s.busy
                        ? "arrow.triangle.2.circlepath" : s.ready ? "checkmark" : "clock"
                    ).font(.system(size: 10, weight: .bold))
                      .foregroundStyle(s.ready || s.busy ? Neu.accent : Neu.text3)
                      .frame(width: 24, height: 24).neuInset(Circle(), depth: 2)
                    Text(String(s.key.prefix(8))).font(.system(size: 11.5, design: .monospaced))
                    Spacer()
                    Text(s.busy ? "Preparando" : s.ready ? "Resumen disponible" : "Sin resumen")
                      .font(jf(11.5)).foregroundStyle(Neu.text2)
                  }.padding(.vertical, 4)
                }
              }
            }
          }.reveal(4)
        }
      }
    }
  }
  var divider: some View {
    Rectangle().fill(Neu.lo.opacity(0.35)).frame(height: 1)
      .overlay(Rectangle().fill(Neu.hi).frame(height: 1).offset(y: 1))
  }
  func smallMetric(_ name: String, _ value: Int) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(value.formatted()).font(jf(26, .bold)).kerning(-0.6).monospacedDigit()
        .contentTransition(.numericText(value: Double(value)))
      Text(name).font(jf(11.5)).foregroundStyle(Neu.text2)
    }
    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    .neuInset(radius: 18, depth: 3)
  }
}

// MARK: - Modelos y API

struct ProvidersView: View {
  @ObservedObject var model: AppModel
  @State var editing: Provider?
  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      HStack(alignment: .bottom) {
        PageHeader(page: .providers)
        Spacer()
        Button {
          editing = Provider.new
        } label: {
          Label("Agregar API", systemImage: "plus")
        }.buttonStyle(.neuProminent).padding(.bottom, 10)
      }
      ForEach(Array((model.draft?.providers ?? []).enumerated()), id: \.element.id) { i, p in
        VStack(alignment: .leading, spacing: 18) {
          HStack(alignment: .top, spacing: 14) {
            ClientIcon(
              client: p.auth == "codex" ? "codex" : p.kind == "anthropic" ? "claude" : "api",
              size: 44)
            VStack(alignment: .leading, spacing: 5) {
              Text(p.name).font(jf(15.5, .bold))
              Text(p.model.isEmpty ? "Modelo pendiente" : p.model).font(
                .system(size: 11.5, design: .monospaced)
              )
              .foregroundStyle(Neu.text2)
              Text(p.auth == "codex" || p.auth == "claude" ? "Usa tu sesión existente" : p.baseURL)
                .font(jf(11.5)).foregroundStyle(Neu.text2)
            }
            Spacer()
            Button("Editar") { editing = p }.buttonStyle(.neuCompact)
          }
          HStack(spacing: 14) {
            price("Entrada", p.inputPrice)
            price("Salida", p.outputPrice)
            price("Lectura de caché", p.cachePrice)
          }
          Text(
            "USD por millón de tokens · \(p.priceSource.isEmpty ? "Tarifa pendiente" : p.auth == "key" ? "Tarifa configurable" : "API equivalente a tu suscripción")"
          ).font(jf(10.5)).foregroundStyle(Neu.text3)
        }
        .padding(22).frame(maxWidth: .infinity, alignment: .leading)
        .neuRaised(radius: 26, depth: 8)
        .reveal(i + 1)
      }
      Label(
        "Las claves se guardan en el Llavero de macOS y no se incluyen al compartir la app.",
        systemImage: "lock.shield"
      ).font(jf(11.5)).foregroundStyle(Neu.text2).padding(.horizontal, 4)
    }.sheet(item: $editing) { p in ProviderEditor(model: model, provider: p) }
  }
  func price(_ title: String, _ value: Double?) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title).font(jf(10.5, .medium)).foregroundStyle(Neu.text2)
      Text(value.map { currency($0) } ?? "Sin tarifa").font(jf(15, .bold)).monospacedDigit()
        .foregroundStyle(value == nil ? Neu.text3 : Neu.text)
    }
    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
    .neuInset(radius: 16, depth: 3)
  }
}

struct ProviderEditor: View {
  @ObservedObject var model: AppModel
  @State var provider: Provider
  @State var key = ""
  @State var busy = false
  @State var result: String?
  @State var models: [AppModel.ModelList.Item] = []
  @Environment(\.dismiss) var dismiss
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Configurar proveedor").font(jf(22, .bold)).kerning(-0.5)
        Spacer()
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(
            Neu.text2
          )
          .frame(width: 30, height: 30)
        }.buttonStyle(KnobStyle())
      }.padding(.horizontal, 26).padding(.top, 24).padding(.bottom, 14)
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          group("Conexión") {
            row("Nombre") { TextField("Nombre", text: $provider.name).neuField(width: 320) }
            row("Formato de API") {
              NeuMenu(
                selection: $provider.kind,
                options: [
                  ("openai", "OpenAI Responses"), ("anthropic", "Anthropic Messages"),
                  ("compatible", "OpenAI Chat Completions"),
                ],
                width: 320)
            }
            row("Autenticación") {
              NeuMenu(
                selection: $provider.auth,
                options: [
                  ("key", "API key"), ("none", "Sin clave · servidor local"),
                  ("codex", "Sesión de Codex"), ("claude", "Sesión de Claude Code"),
                ],
                width: 320)
            }
            row("URL base") {
              TextField("https://", text: $provider.baseURL).textContentType(.URL).neuField(
                width: 320, mono: true)
            }
            if provider.auth == "key" {
              row("API key") {
                SecureField("Vacía para conservar la actual", text: $key).neuField(width: 320)
              }
            }
            row("Modelo") {
              TextField("Modelo", text: $provider.model).neuField(width: 320, mono: true)
            }
            if !models.isEmpty {
              row("Modelos disponibles") {
                NeuMenu(
                  selection: $provider.model, options: models.map { ($0.id, $0.name) }, width: 320)
              }
            }
            row("Ventana de contexto") {
              TextField("Tokens", value: $provider.contextWindow, format: .number).neuField(
                width: 320)
            }
          }
          group("Costo API equivalente · USD por millón de tokens") {
            row("Entrada") { priceField("Entrada", value: $provider.inputPrice) }
            row("Salida") { priceField("Salida", value: $provider.outputPrice) }
            row("Lectura de caché") { priceField("Lectura de caché", value: $provider.cachePrice) }
            row("Escritura de caché") {
              priceField("Escritura de caché", value: $provider.cacheWritePrice)
            }
            Text(
              "Deja la tarifa vacía si no la conoces. El costo aparecerá incompleto en lugar de inventar un valor."
            ).font(jf(11.5)).foregroundStyle(Neu.text2)
          }
          if let result {
            group("Resultado") {
              Text(result).font(jf(12.5)).textSelection(.enabled)
            }.transition(.opacity)
          }
        }.padding(.horizontal, 26).padding(.vertical, 16)
      }.scrollIndicators(.never)
      HStack(spacing: 12) {
        if !["codex-account", "claude-account"].contains(provider.id) {
          Button("Eliminar") {
            Task {
              await model.removeProvider(provider.id)
              if model.error == nil { dismiss() }
            }
          }.buttonStyle(.neuDestructive)
        }
        Spacer()
        if busy { ProgressView().controlSize(.small) }
        Button("Guardar y probar") {
          Task {
            busy = true
            defer { busy = false }
            do {
              try await model.saveProvider(provider, key: key)
              key = ""
              let r = await model.testProvider(provider.id)
              withAnimation(Neu.spring) { result = r }
              models = (try? await model.models(provider.id)) ?? []
            } catch { result = error.localizedDescription }
          }
        }.buttonStyle(.neu)
        Button("Guardar") {
          Task {
            busy = true
            defer { busy = false }
            do {
              try await model.saveProvider(provider, key: key)
              dismiss()
            } catch { result = error.localizedDescription }
          }
        }.buttonStyle(.neuProminent)
      }.padding(.horizontal, 26).padding(.vertical, 18).disabled(busy)
    }
    .font(jf(13)).foregroundStyle(Neu.text)
    .frame(width: 650, height: 720).background(Neu.base).tint(Neu.accent)
  }
  func group<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(title).font(jf(13.5, .bold))
      content()
    }
    .padding(20).frame(maxWidth: .infinity, alignment: .leading)
    .neuRaised(radius: 22, depth: 7)
  }
  func row<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
    HStack {
      Text(label).font(jf(12.5, .medium)).foregroundStyle(Neu.text2)
      Spacer()
      content()
    }
  }
  func priceField(_ title: String, value: Binding<Double?>) -> some View {
    TextField(
      "Sin tarifa",
      text: Binding(
        get: { value.wrappedValue.map { String($0) } ?? "" },
        set: { value.wrappedValue = Double($0.replacingOccurrences(of: ",", with: ".")) })
    ).neuField(width: 160)
  }
}

// MARK: - Actividad

struct ActivityView: View {
  @ObservedObject var model: AppModel
  var body: some View {
    if let s = model.snapshot {
      VStack(alignment: .leading, spacing: 26) {
        HStack(alignment: .bottom) {
          PageHeader(page: .activity)
          Spacer()
          HStack(spacing: 14) {
            NeuSegmented(
              selection: $model.period, options: [(1, "Hoy"), (7, "7 días"), (30, "30 días")]
            )
            .onChange(of: model.period) { _, _ in Task { await model.refresh() } }
            Button {
              Task { await model.exportUsage() }
            } label: {
              Label("Exportar", systemImage: "square.and.arrow.up")
            }.buttonStyle(.neu)
          }.padding(.bottom, 10)
        }
        Panel(title: "Tokens observados") {
          if s.usage.chart.isEmpty {
            VStack(spacing: 12) {
              Image(systemName: "chart.bar").font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Neu.accent)
                .frame(width: 54, height: 54).neuInset(Circle(), depth: 3)
              Text("Aún no hay consumo").font(jf(14, .semibold))
              Text("Abre una conversación con Compacta activado para ver datos reales.").font(
                jf(12)
              )
              .foregroundStyle(Neu.text2)
            }.frame(maxWidth: .infinity).frame(height: 180)
          } else {
            Chart(s.usage.chart) { p in
              BarMark(
                x: .value("Hora", hourLabel(p.hour)), y: .value("Tokens", p.input),
                width: .fixed(22)
              )
              .foregroundStyle(
                LinearGradient(
                  colors: [Neu.accent2, Neu.accent], startPoint: .top, endPoint: .bottom)
              ).cornerRadius(4)
              BarMark(
                x: .value("Hora", hourLabel(p.hour)), y: .value("Tokens", p.output),
                width: .fixed(22)
              )
              .foregroundStyle(Neu.accent.opacity(0.3)).cornerRadius(4)
            }
            .chartLegend(.hidden)
            .chartXAxis {
              AxisMarks { _ in AxisValueLabel().font(jf(9.5)).foregroundStyle(Neu.text3) }
            }
            .chartYAxis {
              AxisMarks { value in
                AxisGridLine().foregroundStyle(Neu.lo.opacity(0.4))
                AxisValueLabel {
                  if let v = value.as(Int.self) {
                    Text(v.compact).font(jf(9.5)).foregroundStyle(Neu.text3)
                  }
                }
              }
            }
            .frame(height: 190).padding(16).neuInset(radius: 18, depth: 3)
            HStack(spacing: 20) {
              legend("Entrada", Neu.accent)
              legend("Salida", Neu.accent.opacity(0.35))
            }
          }
        }.reveal(1)
        Panel(
          title: "Consumo por modelo",
          subtitle: "Conversación y compactación se contabilizan por separado."
        ) {
          if s.usage.models.isEmpty {
            Text("Los modelos aparecerán aquí con su primer consumo.").font(jf(12.5))
              .foregroundStyle(Neu.text2)
          } else {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 14) {
              GridRow {
                Text("Modelo / uso")
                Text("Entrada")
                Text("Salida")
                Text("Costo USD")
              }.font(jf(10.5, .semibold)).foregroundStyle(Neu.text3)
              ForEach(s.usage.models) { m in
                GridRow {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(m.model).font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    Text(
                      "\(m.client.capitalized) · \(m.kind == "compaction" ? "Compactación" : m.kind == "conversation" ? "Conversación" : "Prueba")"
                    ).font(jf(10.5)).foregroundStyle(Neu.text2)
                  }
                  Text(m.input.compact)
                  Text(m.output.compact)
                  Text(m.unpriced > 0 ? "\(currency(m.cost))*" : currency(m.cost)).fontWeight(
                    .semibold)
                }.font(jf(12)).monospacedDigit()
              }
            }
          }
          if s.usage.unpriced > 0 {
            Text(
              "* Hay solicitudes sin tarifa. El total sólo incluye los modelos con precio conocido."
            )
            .font(jf(11)).foregroundStyle(Neu.warn)
          }
        }.reveal(2)
        Panel(title: "Actividad reciente") {
          if s.events.isEmpty {
            Text("Todavía no hay actividad.").font(jf(12.5)).foregroundStyle(Neu.text2)
          }
          ForEach(s.events.prefix(30)) { e in
            HStack(alignment: .top, spacing: 12) {
              Image(
                systemName: e.level == "error"
                  ? "exclamationmark" : e.level == "warning" ? "clock" : "checkmark"
              ).font(.system(size: 10, weight: .bold))
                .foregroundStyle(
                  e.level == "error" ? Neu.warn : e.level == "warning" ? Neu.accent2 : Neu.accent
                )
                .frame(width: 26, height: 26).neuInset(Circle(), depth: 2)
              VStack(alignment: .leading, spacing: 3) {
                Text(e.title).font(jf(12.5, .semibold))
                if !e.detail.isEmpty {
                  Text(e.detail).font(jf(11.5)).foregroundStyle(Neu.text2)
                }
              }
              Spacer()
              Text(parsedDate(e.at)?.formatted(date: .omitted, time: .shortened) ?? "").font(
                jf(10.5)
              )
              .foregroundStyle(Neu.text3)
            }
          }
        }.reveal(3)
      }
    }
  }
  /// "2026-10-21T15" → "15 h"; "2026-10-21" → "21/10".
  func hourLabel(_ raw: String) -> String {
    if let t = raw.firstIndex(of: "T") {
      let h = raw[raw.index(after: t)...].prefix(2)
      return model.period == 1
        ? "\(h) h" : "\(raw[raw.index(t, offsetBy: -2)..<t])/\(raw.dropFirst(5).prefix(2)) \(h)h"
    }
    let parts = raw.split(separator: "-")
    return parts.count == 3 ? "\(parts[2])/\(parts[1])" : raw
  }
  func legend(_ title: String, _ color: Color) -> some View {
    HStack(spacing: 6) {
      RoundedRectangle(cornerRadius: 3).fill(color).frame(width: 10, height: 10)
      Text(title).font(jf(11, .medium)).foregroundStyle(Neu.text2)
    }
  }
}

// MARK: - Ajustes

struct PreferencesView: View {
  @ObservedObject var model: AppModel
  var settings: Binding<Settings> { Binding(get: { model.draft! }, set: { model.draft = $0 }) }
  var body: some View {
    if model.draft != nil {
      VStack(alignment: .leading, spacing: 26) {
        PageHeader(page: .settings)
        Panel(title: "En tu Mac") {
          Toggle(isOn: settings.launchAtLogin) {
            Text("Mostrar Compacta al iniciar sesión").font(jf(13))
          }.toggleStyle(.neu)
          HStack {
            Text("Apariencia").font(jf(13))
            Spacer()
            NeuSegmented(
              selection: settings.appearance,
              options: [("system", "Sistema"), ("light", "Clara"), ("dark", "Oscura")])
          }
          Text(
            "El motor sigue disponible en segundo plano para mantener las conexiones, aunque cierres la ventana."
          ).font(jf(11.5)).foregroundStyle(Neu.text2)
        }.reveal(1)
        Panel(title: "Consumo y registros") {
          HStack {
            Text("Límite diario de compactación").font(jf(13))
            Spacer()
            TextField("USD", value: settings.dailyBudget, format: .number).neuField(width: 110)
            Text("USD").font(jf(12)).foregroundStyle(Neu.text2)
          }
          Text(
            "Costo API equivalente. Usa 0 para no limitar. Al alcanzarlo, se detienen nuevas preparaciones; tu conversación sigue funcionando."
          ).font(jf(11.5)).foregroundStyle(Neu.text2)
          NeuStepper(
            title: "Conservar registro de consumo: \(settings.wrappedValue.retentionDays) días",
            value: settings.retentionDays, range: 1...365)
          NeuStepper(
            title: "Consultar límites cada \(settings.wrappedValue.pollSeconds / 60) minutos",
            value: settings.pollSeconds, range: 60...3600, step: 60)
        }.reveal(2)
        Panel(title: "Privacidad y distribución") {
          privacy("key.horizontal", "Claves protegidas por el Llavero de macOS")
          privacy("desktopcomputer", "Configuración y registros privados en este Mac")
          privacy("shippingbox", "El instalador no incluye cuentas ni conversaciones")
          Text(
            "El proveedor elegido recibe el contexto del resumen. El costo equivale a tarifas API estándar. Con una suscripción no es un cargo adicional; con una API key, el proveedor sí factura su uso."
          ).font(jf(11.5)).foregroundStyle(Neu.text2).lineSpacing(3)
        }.reveal(3)
        Panel(title: "Servicio") {
          HStack(spacing: 12) {
            StatusPill(model: model)
            Spacer()
            Button("Abrir diagnóstico") { model.openLogs() }.buttonStyle(.neuCompact)
            Button("Comprobar conexión") {
              Task {
                await model.refresh()
                model.showNotice(
                  model.connected ? "Servicio conectado" : "Sin conexión con el servicio")
              }
            }.buttonStyle(.neuCompact)
          }
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text("Desactivar en ambos clientes").font(jf(13, .semibold))
              Text("Restaura sus conexiones sin eliminar conversaciones.").font(jf(11.5))
                .foregroundStyle(Neu.text2)
            }
            Spacer()
            Button("Desactivar") {
              Task { await model.activate(codex: false, claude: false) }
            }.buttonStyle(.neuDestructive).disabled(model.working)
          }
          .padding(16).neuInset(radius: 18, depth: 3)
        }.reveal(4)
      }
    }
  }
  func privacy(_ symbol: String, _ text: String) -> some View {
    HStack(spacing: 12) {
      Image(systemName: symbol).font(.system(size: 12, weight: .semibold)).foregroundStyle(
        Neu.accent
      )
      .frame(width: 32, height: 32).neuRaised(radius: 10, depth: 3)
      Text(text).font(jf(13))
    }
  }
}

// MARK: - Menú de la barra

struct MenuPanel: View {
  @ObservedObject var model: AppModel
  var open: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        LogoTile(size: 30)
        VStack(alignment: .leading, spacing: 1) {
          Text("Compacta").font(jf(15, .bold))
          Text(model.statusTitle).font(jf(11, .medium))
            .foregroundStyle(
              model.connected && model.snapshot?.config.paused != true ? Neu.accent : .secondary)
        }
        Spacer()
        if model.working { ProgressView().controlSize(.small) }
      }
      if let s = model.snapshot {
        HStack(spacing: 10) {
          quotaTile("Codex", client: "codex", s: s)
          quotaTile("Claude Code", client: "claude", s: s)
        }
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Costo API equivalente").font(jf(11, .medium)).foregroundStyle(.secondary)
            Text("Hoy · estimación").font(jf(10)).foregroundStyle(.tertiary)
          }
          Spacer()
          Text(currency(s.usage.cost)).font(jf(20, .bold)).kerning(-0.5).monospacedDigit()
        }
        .padding(12).background(
          tileFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        VStack(spacing: 2) {
          action(
            s.config.paused ? "Reanudar preparación" : "Pausar preparación",
            symbol: s.config.paused ? "play.fill" : "pause.fill", highlight: s.config.paused
          ) {
            Task { await model.setPaused(!s.config.paused) }
          }
          action("Abrir Compacta", symbol: "macwindow", trailing: "arrow.up.forward", action: open)
        }
      } else {
        action("Abrir Compacta", symbol: "macwindow", trailing: "arrow.up.forward", action: open)
      }
      Divider().opacity(0.6)
      Button {
        NSApp.terminate(nil)
      } label: {
        HStack {
          Text("Salir de Compacta")
          Spacer()
          Text("El servicio sigue activo").foregroundStyle(.tertiary)
        }.font(jf(11)).foregroundStyle(.secondary).contentShape(Rectangle())
      }.buttonStyle(.plain)
    }
    .padding(16).frame(width: 320).tint(Neu.accent)
  }
  var tileFill: some ShapeStyle { Color.primary.opacity(0.05) }
  func quotaTile(_ name: String, client: String, s: Snapshot) -> some View {
    let q = s.quotas[client]
    let limit =
      q?.limits.first(where: { $0.label == "Semana" })
      ?? q?.limits.max(by: { $0.usedPercent < $1.usedPercent })
    let pct = limit?.usedPercent ?? 0
    let warn = pct >= 85
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Image(systemName: client == "claude" ? "asterisk" : "terminal").font(
          .system(size: 10, weight: .bold)
        )
        .foregroundStyle(client == "claude" ? Neu.claude : .primary)
        Text(name).font(jf(11.5, .semibold))
      }
      HStack(alignment: .center, spacing: 10) {
        ZStack {
          Circle().stroke(Color.primary.opacity(0.08), lineWidth: 5)
          Circle().trim(from: 0, to: min(1, pct / 100))
            .stroke(warn ? Neu.warn : Neu.accent, style: StrokeStyle(lineWidth: 5, lineCap: .round))
            .rotationEffect(.degrees(-90))
            .animation(.spring(response: 1, dampingFraction: 0.85), value: pct)
        }.frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 0) {
          Text(q?.available == true && limit != nil ? "\(Int(pct.rounded())) %" : "—").font(
            jf(17, .bold)
          )
          .monospacedDigit().foregroundStyle(warn ? Neu.warn : .primary)
          Text(limit?.label.lowercased() ?? "sin datos").font(jf(10)).foregroundStyle(.secondary)
        }
      }
    }
    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
    .background(tileFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
  func action(
    _ title: String, symbol: String, trailing: String? = nil, highlight: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    MenuAction(
      title: title, symbol: symbol, trailing: trailing, highlight: highlight, action: action)
  }
}

struct MenuAction: View {
  var title: String
  var symbol: String
  var trailing: String?
  var highlight: Bool
  var action: () -> Void
  @State private var hover = false
  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
          .foregroundStyle(highlight || hover ? Color.white : Neu.accent)
          .frame(width: 26, height: 26)
          .background(
            highlight || hover ? AnyShapeStyle(Neu.fill) : AnyShapeStyle(Neu.accent.opacity(0.12)),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        Text(title).font(jf(13, .semibold))
        Spacer()
        if let trailing {
          Image(systemName: trailing).font(.system(size: 10, weight: .bold)).foregroundStyle(
            .secondary)
        }
      }
      .padding(.horizontal, 6).padding(.vertical, 5)
      .background(
        hover ? Color.primary.opacity(0.06) : .clear,
        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hover = h } }
  }
}
