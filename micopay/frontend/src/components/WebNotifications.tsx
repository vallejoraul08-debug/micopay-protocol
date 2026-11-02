import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getActiveTrades, getTrade, type TradeData } from '../services/api';
import {
  diffActiveTrades,
  finalNotice,
  newMessageNotices,
  type ChatMessageLite,
  type TradeNotice,
} from '../utils/tradeNotices';

/**
 * WP8 · avisos en la version de PC: operaciones nuevas, cambios de estado y
 * mensajes del chat. Revisa cada 30 s con los endpoints que ya existen; el
 * primer ciclo solo toma la foto inicial para no avisar de lo que ya habia.
 *
 * Se muestran dentro de la app y, si la persona da permiso, tambien como
 * notificacion del navegador (sirve con la pestaña en segundo plano).
 */

// 30 s: el chat abierto ya consulta cada 3 s y el limite es de 30 por minuto.
const POLL_MS = 30_000;
const MAX_VISIBLE = 3;
const API_URL = import.meta.env.VITE_API_URL as string | undefined;

interface Props {
  token: string;
  userId: string;
  /** Inyectable para pruebas. */
  pollMs?: number;
}

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export default function WebNotifications({ token, userId, pollMs = POLL_MS }: Props) {
  const navigate = useNavigate();
  const [notices, setNotices] = useState<TradeNotice[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    notificationsSupported() ? Notification.permission : 'unsupported',
  );
  const snapshotRef = useRef<Map<string, TradeData> | null>(null);
  const lastMessageAtRef = useRef<Map<string, string>>(new Map());
  const shownRef = useRef<Set<string>>(new Set());

  const push = useCallback((incoming: TradeNotice[]) => {
    const fresh = incoming.filter((n) => !shownRef.current.has(n.key));
    if (fresh.length === 0) return;
    fresh.forEach((n) => shownRef.current.add(n.key));
    setNotices((prev) => [...fresh, ...prev].slice(0, MAX_VISIBLE));
    if (notificationsSupported() && Notification.permission === 'granted' && document.hidden) {
      for (const n of fresh) {
        try {
          const system = new Notification(n.title, { body: n.body, tag: n.key });
          system.onclick = () => { window.focus(); navigate(n.path); system.close(); };
        } catch {
          // Algunos navegadores solo permiten notificar desde un service worker.
        }
      }
    }
  }, [navigate]);

  const fetchMessages = useCallback(async (tradeId: string): Promise<ChatMessageLite[]> => {
    if (!API_URL) return [];
    const res = await fetch(`${API_URL}/trades/${tradeId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.messages ?? []) as ChatMessageLite[];
  }, [token]);

  const poll = useCallback(async () => {
    let active: TradeData[];
    try {
      active = await getActiveTrades(token);
    } catch {
      return; // sin red se intenta en el siguiente ciclo
    }

    const first = snapshotRef.current === null;
    const previous = snapshotRef.current ?? new Map<string, TradeData>();
    const collected: TradeNotice[] = [];

    if (!first) {
      const { notices: changes, gone } = diffActiveTrades(previous, active, userId);
      collected.push(...changes);
      for (const id of gone) {
        const final = await getTrade(id, token).catch(() => null);
        const notice = final ? finalNotice(final) : null;
        if (notice) collected.push(notice);
        lastMessageAtRef.current.delete(id);
      }
    }

    for (const trade of active) {
      const messages = await fetchMessages(trade.id).catch(() => []);
      const newest = messages.length > 0 ? messages[messages.length - 1].created_at : null;
      const lastSeen = lastMessageAtRef.current.get(trade.id) ?? null;
      // Una operacion recien vista toma su ultimo mensaje como punto de partida.
      if (!first && previous.has(trade.id)) {
        collected.push(...newMessageNotices(trade, messages, userId, lastSeen));
      }
      if (newest) lastMessageAtRef.current.set(trade.id, newest);
    }

    snapshotRef.current = new Map(active.map((t) => [t.id, t]));
    push(collected);
  }, [token, userId, fetchMessages, push]);

  useEffect(() => {
    snapshotRef.current = null;
    void poll();
    const interval = setInterval(() => { void poll(); }, pollMs);
    return () => clearInterval(interval);
  }, [poll, pollMs]);

  const askPermission = async () => {
    if (!notificationsSupported()) return;
    setPermission(await Notification.requestPermission());
  };

  const dismiss = (key: string) => setNotices((prev) => prev.filter((n) => n.key !== key));

  if (notices.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
      data-testid="web-notifications"
    >
      {notices.map((n) => (
        <div key={n.key} className="rounded-sm border-2 border-tinta bg-papel p-3 shadow-solida">
          <button
            type="button"
            onClick={() => { dismiss(n.key); navigate(n.path); }}
            className="block w-full text-left"
          >
            <p className="text-sm font-bold text-tinta">{n.title}</p>
            <p className="text-sm text-gris">{n.body}</p>
          </button>
          <div className="mt-2 flex items-center justify-between gap-2">
            {permission === 'default' ? (
              <button type="button" onClick={askPermission} className="text-xs font-bold text-verde underline">
                Avisarme también fuera de esta pestaña
              </button>
            ) : <span />}
            <button type="button" onClick={() => dismiss(n.key)} className="text-xs text-gris underline">
              Cerrar
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
