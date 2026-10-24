<p align="center"><img src="../assets/compacta-logo.svg" width="96" alt="Logo de Compacta"></p>
<h1 align="center">Compacta</h1>
<p align="center"><strong>Prepara el contexto. Sigue trabajando.</strong><br>Una app nativa para macOS que adelanta los resúmenes de tus conversaciones.</p>
<p align="center"><a href="../../README.md">English</a> · MIT · Apple Silicon · macOS 14+</p>

![Preparación de contexto](../assets/overview.svg)

Compacta prepara y actualiza un resumen mientras tu agente programa. Cuando Codex
solicita compactar, intenta aplicar ese resumen y conservar completos los pasos
recientes. Si el historial cambió de verdad o falta trabajo, espera o conserva la
compactación nativa.

**Estado:** versión 1.0.5. Descarga la app desde
[GitHub Releases](https://github.com/manomx/compacta/releases) o compílala desde
el código. Sin notarización, macOS pide abrirla a mano la primera vez. La
interfaz está en español. Proyecto independiente de OpenAI y Anthropic.

## Descargar

Necesitas Apple Silicon y macOS 14 o posterior.

Descarga `Compacta-<versión>-macOS-arm64.dmg` desde
[GitHub Releases](https://github.com/manomx/compacta/releases). Abre la imagen y
arrastra **Compacta** a **Aplicaciones**. Al abrirla, se copia a
`~/Applications/Compacta.app` e inicia su servicio por usuario. El release
también incluye un `.zip`.

Si la compilación está notarizada, ábrela con normalidad. Si es ad hoc,
Gatekeeper la bloquea la primera vez:

- Clic derecho en `Compacta.app` y elige **Abrir**, luego **Abrir**.
- **Ajustes del Sistema → Privacidad y seguridad → Abrir de todas formas**
  (Open Anyway).
- O quita solo la cuarentena de esa copia:

```sh
xattr -dr com.apple.quarantine /Applications/Compacta.app
```

Eso no desactiva Gatekeeper.

## Instalar desde el código

Requiere además Node.js 22+ y Xcode Command Line Tools.

```sh
git clone https://github.com/manomx/compacta.git
cd compacta
npm ci
npm run check
npm test
npm run build
open build/Compacta.app
```

Al abrirla, la app se copia a `~/Applications/Compacta.app` e inicia su servicio
por usuario. Elige Codex, Claude Code o ambos; selecciona un modelo disponible en
tu cuenta y prueba la conexión antes de activarla.

En una conexión nueva de Codex, abre un chat nuevo. Los chats existentes conservan
su conexión. Claude Code requiere una sesión nueva. El puente anterior de
Compacta permite cambiar de servicio sin reiniciar Codex.

## Qué incluye

- Resúmenes durante los pasos terminados y al finalizar una respuesta.
- Modelo, proveedor, instrucciones y límites configurables.
- Un resumen ordenado por chat; `0` elimina el límite global de concurrencia de Codex.
- Indicador en la barra de menús, actividad, tokens y costos estimados.
- Claves API en el Llavero y desactivación reversible de las integraciones.

Claude Code usa una integración por umbral diferente de la de Codex y tiene menos
validación con el cliente real. No se promete una espera fija: influyen el
proveedor, su cuota, los pasos pendientes y el tamaño del contexto reciente.

## Datos y consumo

El servicio se ejecuta en tu Mac. Las conversaciones y los resúmenes se envían al
proveedor elegido; un resumidor adicional puede recibir el contenido de mensajes
y herramientas. La caché, los respaldos y el contexto reciente quedan en disco
con permisos de usuario; no están cifrados por Compacta.

La preparación consume cuota o crédito API. El costo mostrado es una equivalencia
editable, no la factura de tu suscripción. Desactivar una integración restaura la
ruta anterior. Cerrar la ventana no detiene el servicio.

Consulta [instalación y retiro](../INSTALLATION.md), [privacidad](../PRIVACY.md),
[configuración](../CONFIGURATION.md) y [limitaciones](../LIMITATIONS.md).

## Colaborar

La documentación técnica está inicialmente en inglés. Puedes reportar problemas
y proponer mejoras en español o inglés. Lee [cómo contribuir](../../CONTRIBUTING.md),
[la política de seguridad](../../SECURITY.md) y [la licencia MIT](../../LICENSE).
