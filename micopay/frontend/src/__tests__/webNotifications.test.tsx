/** WP8 · el componente avisa cambios después de la foto inicial. */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getActiveTrades, getTrade } = vi.hoisted(() => ({ getActiveTrades: vi.fn(), getTrade: vi.fn() }));
vi.mock('../services/api', () => ({ getActiveTrades, getTrade }));
import WebNotifications from '../components/WebNotifications';

const trade = (status: string) => ({
  id: 'trade-9', status, secret_hash: 'h', amount_mxn: 500, flow: 'cashout',
  seller_id: 'client', buyer_id: 'agent', provider_id: 'agent',
});

describe('WebNotifications', () => {
  it('no avisa lo que ya existía; avisa una solicitud nueva y lleva a la operación', async () => {
    getActiveTrades.mockResolvedValueOnce([]).mockResolvedValue([trade('pending')]);
    render(
      <MemoryRouter initialEntries={['/']}>
        <WebNotifications token="tok" userId="agent" pollMs={30} />
        <Routes>
          <Route path="/" element={<div>INICIO</div>} />
          <Route path="/trade/:id" element={<div>DETALLE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Nueva solicitud')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Nueva solicitud'));
    await waitFor(() => expect(screen.getByText('DETALLE')).toBeInTheDocument());
  });
});
