/** WP8 · qué se avisa en PC. */
import { describe, it, expect } from 'vitest';
import { diffActiveTrades, finalNotice, newMessageNotices } from '../utils/tradeNotices';
import type { TradeData } from '../services/api';

const AGENT = 'agent';
const CLIENT = 'client';
const t = (patch: Partial<TradeData>): TradeData => ({
  id: 't1', status: 'pending', secret_hash: 'h', amount_mxn: 500, flow: 'cashout',
  seller_id: CLIENT, buyer_id: AGENT, provider_id: AGENT, ...patch,
} as TradeData);

describe('diffActiveTrades', () => {
  it('avisa al agente de una solicitud nueva, con el nombre del flujo', () => {
    const { notices } = diffActiveTrades(new Map(), [t({})], AGENT);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe('Nueva solicitud');
    expect(notices[0].body).toContain('Convertir a efectivo');
  });

  it('no le avisa al cliente de la operación que él mismo creó', () => {
    expect(diffActiveTrades(new Map(), [t({})], CLIENT).notices).toHaveLength(0);
  });

  it('avisa cuando los fondos quedan en garantía', () => {
    const prev = new Map([['t1', t({})]]);
    const { notices } = diffActiveTrades(prev, [t({ status: 'locked' })], CLIENT);
    expect(notices[0].title).toBe('Fondos en garantía');
  });

  it('en "Comprar con efectivo" le dice al cliente que ya puede recibir', () => {
    const deposit = { flow: 'deposit' as const, seller_id: AGENT, buyer_id: CLIENT };
    const prev = new Map([['t1', t({ ...deposit, status: 'locked' })]]);
    const { notices } = diffActiveTrades(prev, [t({ ...deposit, status: 'revealing' })], CLIENT);
    expect(notices[0].body).toContain('Ya puedes recibir tus activos');
  });

  it('sin cambios no avisa nada', () => {
    const prev = new Map([['t1', t({ status: 'locked' })]]);
    expect(diffActiveTrades(prev, [t({ status: 'locked' })], AGENT).notices).toHaveLength(0);
  });

  it('marca como terminadas las que dejaron de estar activas', () => {
    const prev = new Map([['t1', t({ status: 'locked' })]]);
    expect(diffActiveTrades(prev, [], AGENT).gone).toEqual(['t1']);
  });
});

describe('finalNotice', () => {
  it('distingue completada, cancelada y devuelta', () => {
    expect(finalNotice(t({ status: 'completed' }))?.title).toBe('Operación completada');
    expect(finalNotice(t({ status: 'cancelled' }))?.title).toBe('La operación se canceló');
    expect(finalNotice(t({ status: 'refunded' }))?.title).toBe('Fondos devueltos');
  });
});

describe('newMessageNotices', () => {
  const msgs = [
    { id: 'm1', sender_id: CLIENT, body: 'viejo', created_at: '2026-11-01T10:00:00Z' },
    { id: 'm2', sender_id: AGENT, body: 'mío', created_at: '2026-11-01T10:05:00Z' },
    { id: 'm3', sender_id: CLIENT, body: 'ya llegué', created_at: '2026-11-01T10:06:00Z' },
  ];
  it('solo avisa los mensajes nuevos de la otra parte y lleva al chat', () => {
    const notices = newMessageNotices(t({}), msgs, AGENT, '2026-11-01T10:00:00Z');
    expect(notices.map((n) => n.body)).toEqual(['ya llegué']);
    expect(notices[0].path).toBe('/chat/t1');
  });
});
