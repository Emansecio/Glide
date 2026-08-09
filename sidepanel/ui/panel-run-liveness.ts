import { SidePanelUI } from './panel-ui.js';

/**
 * Watchdog do lado do PAINEL.
 *
 * O estado do run vive na memória do service worker (MV3). Se o Chrome despejar o
 * worker no meio de um run, nenhum `run_error`/`assistant_final` chega — e o
 * composer ficava travado em "executando" para sempre, porque o guard de envio
 * bloqueia nova mensagem e nada acordava o worker para ele se recuperar.
 *
 * Aqui, depois de um período de silêncio, perguntamos ao worker se o run ainda
 * existe. O simples envio da mensagem RESSUSCITA o worker (que então executa
 * `recoverOrphanedRun`); a resposta diz se há run ativo. Só destravamos a UI
 * quando o worker confirma que não há (ou quando ele não responde), então uma
 * ferramenta legitimamente lenta nunca é interrompida por engano.
 *
 * Interplay with the push port: reconnect is lazy while idle so an open panel does
 * not keep waking the service worker on a timer. During an active run,
 * shouldReconnect keeps the port up; if it drops, sendMessage still works until
 * reconnect. This watchdog is unchanged and still probes via run_status_query when
 * push events go silent.
 */
const POLL_INTERVAL_MS = 5000;
/** Silêncio tolerado antes de sondar o worker. */
const SILENCE_BEFORE_PROBE_MS = 25000;
/** Silêncio tolerado quando o worker não responde à sondagem. */
const SILENCE_BEFORE_UNLOCK_MS = 50000;

const isComposerBusy = (ui: SidePanelUI) =>
  Boolean(ui.elements.composer?.classList.contains('running')) || ui.isStreaming || ui.pendingToolCount > 0;

const unlockAfterLostRun = (ui: SidePanelUI, message: string) => {
  ui.stopRunLiveness();
  ui.stopThinkingTimer?.();
  ui.sweepInFlightToolContainers?.();
  ui.finishStreamingMessage?.();
  ui.setComposerBusy(false);
  ui.pendingToolCount = 0;
  ui.isStreaming = false;
  ui.activeToolName = null;
  ui.updateActivityState?.();
  ui.showWarningBanner(message, { timeoutMs: 0 });
  ui.updateStatus('Execução interrompida', 'warning');
  ui.finishActiveRun?.();
};

const probeRunStatus = async (ui: SidePanelUI) => {
  const silenceMs = Date.now() - (ui.runLivenessLastSignalAt || Date.now());

  let status: { activeRunId?: string | null } | null = null;
  try {
    status = await chrome.runtime.sendMessage({ type: 'run_status_query' });
  } catch {
    status = null;
  }

  if (!isComposerBusy(ui)) {
    ui.stopRunLiveness();
    return;
  }

  if (status && typeof status === 'object' && 'activeRunId' in status) {
    if (status.activeRunId) {
      // Run vivo (ferramenta lenta / resposta longa): reinicia a janela de silêncio.
      ui.touchRunLiveness();
      return;
    }
    unlockAfterLostRun(
      ui,
      'A execução anterior foi interrompida porque a extensão reiniciou. Envie a mensagem novamente.',
    );
    return;
  }

  // Sem resposta utilizável: espera mais um pouco antes de desistir.
  if (silenceMs >= SILENCE_BEFORE_UNLOCK_MS) {
    unlockAfterLostRun(ui, 'Perdemos contato com a execução em andamento. Envie a mensagem novamente.');
    return;
  }
  // Rearma a sondagem: sem isto, uma única sondagem sem resposta desligava o
  // watchdog para sempre e o composer ficava travado.
  ui.runLivenessProbeSent = false;
};

SidePanelUI.prototype.touchRunLiveness = function touchRunLiveness() {
  this.runLivenessLastSignalAt = Date.now();
  this.runLivenessProbeSent = false;
};

SidePanelUI.prototype.startRunLiveness = function startRunLiveness() {
  this.stopRunLiveness();
  this.touchRunLiveness();
  this.runLivenessTimerId = setInterval(() => {
    if (!isComposerBusy(this)) {
      this.stopRunLiveness();
      return;
    }
    const silenceMs = Date.now() - (this.runLivenessLastSignalAt || Date.now());
    if (silenceMs < SILENCE_BEFORE_PROBE_MS) return;
    if (this.runLivenessProbeSent) return;
    this.runLivenessProbeSent = true;
    void probeRunStatus(this);
  }, POLL_INTERVAL_MS) as unknown as number;
};

SidePanelUI.prototype.stopRunLiveness = function stopRunLiveness() {
  if (this.runLivenessTimerId !== null) {
    clearInterval(this.runLivenessTimerId);
    this.runLivenessTimerId = null;
  }
  this.runLivenessProbeSent = false;
};
