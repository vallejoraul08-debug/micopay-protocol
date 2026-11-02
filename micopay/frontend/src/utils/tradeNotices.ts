import type { TradeData } from '../services/api';

/**
 * WP8 · avisos en la version de PC.
 *
 * Los push del backend van a Firebase (el APK). En la web no llegaba nada: ni
 * una operacion nueva para el agente, ni un cambio de estado, ni un mensaje
 * del chat. Esta parte decide QUE avisar comparando dos fotos de las
 * operaciones activas; la pantalla solo lo muestra.
 */

export interface TradeNotice {
  /** Para no repetir el mismo aviso. */
  key: string;
  tradeId: string;
  title: string;
  body: string;
  /** A donde lleva tocar el aviso. */
  path: string;
}

export interface ChatMessageLite {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

const money = (amount: unknown) => `$${Number(amount).toLocaleString('es-MX', { maximumFractionDigits: 2 })} MXN`;

/** El nombre con que MicoPay llama a cada flujo en Inicio. */
export function flowLabel(trade: Pick<TradeData, 'flow'>): string {
  return trade.flow === 'cashout' ? 'Convertir a efectivo' : 'Comprar con efectivo';
}

/**
 * Avisos por operaciones nuevas y cambios de estado entre dos fotos de
 * `/trades/active`. Las que desaparecieron se resuelven aparte, con su estado
 * final (`finalNotice`).
 */
export function diffActiveTrades(
  previous: Map<string, TradeData>,
  current: TradeData[],
  me: string,
): { notices: TradeNotice[]; gone: string[] } {
  const notices: TradeNotice[] = [];
  const seen = new Set<string>();

  for (const trade of current) {
    seen.add(trade.id);
    const before = previous.get(trade.id);
    const amount = money(trade.amount_mxn);
    const isProvider = trade.provider_id === me;

    if (!before) {
      // Quien la creo ya lo sabe; avisa a la otra parte.
      if (isProvider) {
        notices.push({
          key: `${trade.id}:new`,
          tradeId: trade.id,
          title: 'Nueva solicitud',
          body: `${flowLabel(trade)} por ${amount}. Ábrela desde tu Bandeja.`,
          path: `/trade/${trade.id}`,
        });
      }
      continue;
    }
    if (before.status === trade.status) continue;

    if (trade.status === 'locked') {
      notices.push({
        key: `${trade.id}:locked`,
        tradeId: trade.id,
        title: 'Fondos en garantía',
        body: `${flowLabel(trade)} por ${amount}: los fondos ya están bloqueados. Ya pueden reunirse.`,
        path: `/trade/${trade.id}`,
      });
    } else if (trade.status === 'revealing') {
      const body = trade.flow === 'deposit'
        ? (isProvider
          ? `Confirmaste el efectivo de ${amount}. El cliente ya puede recibir sus activos.`
          : `El agente confirmó tu efectivo de ${amount}. Ya puedes recibir tus activos.`)
        : (isProvider
          ? `El cliente generó su código para ${amount}. Escanéalo al entregar el efectivo.`
          : `Tu código para ${amount} está listo. Muéstraselo al agente.`);
      notices.push({ key: `${trade.id}:revealing`, tradeId: trade.id, title: 'Tu operación avanzó', body, path: `/trade/${trade.id}` });
    }
  }

  const gone = [...previous.keys()].filter((id) => !seen.has(id));
  return { notices, gone };
}

/** Aviso para una operacion que dejo de estar activa, con su estado final. */
export function finalNotice(trade: TradeData): TradeNotice | null {
  const amount = money(trade.amount_mxn);
  const base = { tradeId: trade.id, path: `/trade/${trade.id}` };
  switch (trade.status) {
    case 'completed':
      return { ...base, key: `${trade.id}:completed`, title: 'Operación completada', body: `${flowLabel(trade)} por ${amount} terminó.` };
    case 'cancelled':
      return { ...base, key: `${trade.id}:cancelled`, title: 'La operación se canceló', body: `${flowLabel(trade)} por ${amount} se canceló.` };
    case 'refunded':
      return { ...base, key: `${trade.id}:refunded`, title: 'Fondos devueltos', body: `Los fondos de ${flowLabel(trade).toLowerCase()} por ${amount} regresaron a quien los bloqueó.` };
    default:
      return null;
  }
}

/** Mensajes de la otra parte posteriores al ultimo visto. */
export function newMessageNotices(
  trade: TradeData,
  messages: ChatMessageLite[],
  me: string,
  lastSeenAt: string | null,
): TradeNotice[] {
  return messages
    .filter((m) => m.sender_id !== me && (!lastSeenAt || m.created_at > lastSeenAt))
    .map((m) => ({
      key: `${trade.id}:msg:${m.id}`,
      tradeId: trade.id,
      title: 'Nuevo mensaje',
      body: m.body.length > 120 ? `${m.body.slice(0, 117)}…` : m.body,
      path: `/chat/${trade.id}`,
    }));
}
