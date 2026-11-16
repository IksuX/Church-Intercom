// Reżyseria – prawdziwy mikser Blackmagic ATEM przez bibliotekę atem-connection.
// Biblioteka sama łączy się ponownie po zerwaniu połączenia.
import { EventEmitter } from 'node:events';
import atemPkg from 'atem-connection';
import { fpsFromVideoModeName } from './pick.js';
import { MAX_TRANSITION_FRAMES } from './settings.js';

const { Atem, Enums } = atemPkg;

const CAMERA_PORTS = new Set([Enums.InternalPortType.External]);
const OTHER_PORTS = new Set([
  Enums.InternalPortType.Black,
  Enums.InternalPortType.ColorBars,
  Enums.InternalPortType.ColorGenerator,
  Enums.InternalPortType.MediaPlayerFill,
  Enums.InternalPortType.SuperSource,
]);
const STYLE_OF = { mix: Enums.TransitionStyle.MIX, dip: Enums.TransitionStyle.DIP, wipe: Enums.TransitionStyle.WIPE };

export const EMPTY_SNAPSHOT = Object.freeze({
  status: 'disconnected', meCount: 1, inputs: [], inTransition: false, supportedTransitions: ['cut'], fps: 25,
});

/** Stan z atem-connection → prosty obraz stanu dla wybranego M/E. Czysta funkcja. */
export function snapshotFromState(state, me, status) {
  if (!state || status !== 'connected') return { ...EMPTY_SNAPSHOT, status };
  const meCount = Math.max(1, state.info?.capabilities?.mixEffects ?? state.video?.mixEffects?.length ?? 1);
  const meBit = 1 << me;
  const inputs = [];
  for (const raw of Object.values(state.inputs ?? {})) {
    if (!raw) continue;
    const kind = CAMERA_PORTS.has(raw.internalPortType) ? 'camera' : OTHER_PORTS.has(raw.internalPortType) ? 'other' : null;
    if (!kind) continue;
    if (raw.meAvailability !== undefined && (raw.meAvailability & meBit) === 0) continue;
    inputs.push({ id: raw.inputId, shortName: raw.shortName, longName: raw.longName, kind });
  }
  inputs.sort((a, b) => a.id - b.id);
  const mix = state.video?.mixEffects?.[me];
  // ATEM nie przysyła listy obsługiwanych przejść – mikser wysyła ustawienia tylko tych, które ma.
  const supported = ['cut'];
  if (mix?.transitionSettings?.mix) supported.push('mix');
  if (mix?.transitionSettings?.dip) supported.push('dip');
  if (mix?.transitionSettings?.wipe) supported.push('wipe');
  return {
    status,
    model: state.info?.productIdentifier || Enums.Model[state.info?.model],
    meCount,
    inputs,
    program: mix?.programInput,
    preview: mix?.previewInput,
    inTransition: Boolean(mix?.transitionPosition?.inTransition),
    supportedTransitions: supported,
    fps: fpsFromVideoModeName(Enums.VideoMode[state.settings?.videoMode]) ?? 25,
  };
}

/** Zdarzenia: 'status', 'update', 'log'. */
export class AtemMixer extends EventEmitter {
  constructor() {
    super();
    this.isSimulation = false;
    this.atem = null;
    this.status = 'disconnected';
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
    this.emit('update');
  }

  async connect(address) {
    await this.disconnect();
    const atem = new Atem();
    this.atem = atem;
    atem.on('connected', () => {
      if (this.atem !== atem) return;
      this.emit('log', `Połączono z mikserem ${address}`);
      this.setStatus('connected');
    });
    atem.on('disconnected', () => {
      if (this.atem !== atem) return;
      this.emit('log', 'Utracono połączenie z mikserem – próbuję ponownie…');
      this.setStatus('reconnecting');
    });
    atem.on('stateChanged', () => { if (this.atem === atem) this.emit('update'); });
    atem.on('error', (e) => this.emit('log', `Błąd ATEM: ${e}`));
    this.setStatus('connecting');
    await atem.connect(address);
  }

  async disconnect() {
    const atem = this.atem;
    this.atem = null;
    this.setStatus('disconnected');
    if (!atem) return;
    atem.removeAllListeners();
    atem.on('error', () => {});
    try { await atem.disconnect(); await atem.destroy(); } catch { /* ignoruj */ }
  }

  snapshot(me) { return snapshotFromState(this.atem?.state, me, this.status); }

  ready() {
    if (!this.atem || this.status !== 'connected') throw new Error('Brak połączenia z mikserem');
    return this.atem;
  }

  async preview(me, input) {
    await this.ready().changePreviewInput(input, me);
  }

  /** Przeniesienie Preview na Program: Cut albo Auto wybranym przejściem. */
  async take(me, kind, frames) {
    const atem = this.ready();
    if (kind === 'cut') return atem.cut(me);
    const rate = Math.max(1, Math.min(MAX_TRANSITION_FRAMES, Math.round(frames)));
    const mix = atem.state?.video.mixEffects[me];
    const style = STYLE_OF[kind];
    if (mix?.transitionProperties.nextStyle !== style) await atem.setTransitionStyle({ nextStyle: style }, me);
    if (kind === 'mix' && mix?.transitionSettings.mix?.rate !== rate) await atem.setMixTransitionSettings({ rate }, me);
    else if (kind === 'dip' && mix?.transitionSettings.dip?.rate !== rate) await atem.setDipTransitionSettings({ rate }, me);
    else if (kind === 'wipe' && mix?.transitionSettings.wipe?.rate !== rate) await atem.setWipeTransitionSettings({ rate }, me);
    await atem.autoTransition(me);
  }

  /** Przejście zawsze przez Preview (nigdy bezpośrednia zmiana Program), żeby Mix/Dip/Wipe działały jak z panelu. */
  async transition(me, input, kind, frames) {
    await this.preview(me, input);
    await this.take(me, kind, frames);
  }
}
