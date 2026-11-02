import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { generateAndStoreKeypair, keypairExists, getPublicKey, revealSecretKey } from './lib/keystore';
import { IS_EXTERNAL_SIGNER } from './lib/signer/mode';
import WalletLogin from './pages/WalletLogin';
import WebSessionGuard from './components/WebSessionGuard';
import WebShell, { type WebNavItem } from './components/WebShell';
import WebScanDialog from './components/WebScanDialog';
import WebNotifications from './components/WebNotifications';
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import ErrorBoundary from './components/ErrorBoundary';

import Home from "./pages/Home";
import Welcome from "./pages/Welcome";
import ProviderOnboarding from "./pages/ProviderOnboarding";
import CashoutRequest from "./pages/CashoutRequest";
import DepositRequest from "./pages/DepositRequest";
import ExploreMap from "./pages/ExploreMap";
import TradeConfirmationPage from "./pages/TradeConfirmation";
import DepositMap from "./pages/DepositMap";
import ChatRoom from "./pages/ChatRoom";
import DepositChat from "./pages/DepositChat";
import QRReveal from "./pages/QRReveal";
import DepositQR from "./pages/DepositQR";
import SuccessScreen, { receiptFromServer, type SuccessReceipt } from "./pages/SuccessScreen";
import Explore from "./pages/Explore";
import ComingSoon from "./pages/ComingSoon";
import { CETES_AVAILABLE, BLEND_AVAILABLE, DEFI_TRADING_ENABLED, SPEI_RAMP_ENABLED, BANK_WITHDRAW_ENABLED } from "./constants/features";
import BankWithdrawScreen from "./pages/BankWithdrawScreen";
import History from "./pages/History";
import TradeDetail from "./pages/TradeDetail";
import CETESScreen from "./pages/CETESScreen";
import BlendScreen from "./pages/BlendScreen";
import KYCScreen from "./pages/KYCScreen";

import MerchantInbox from "./pages/MerchantInbox";
import PayHub from "./pages/PayHub";
import SendPayment from "./pages/SendPayment";
import ReceivePayment from "./pages/ReceivePayment";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import Profile from "./pages/Profile";
import WalletConnections from "./pages/WalletConnections";
import WalletRequestSheet from "./components/WalletRequestSheet";
import { startWalletConnect, stopWalletRequests } from "./services/walletConnect";
import { SignatureApproval } from "./pages/SignatureApproval";
import Login from "./pages/Login";
import Register from "./pages/Register";
import MerchantSettings from "./pages/MerchantSettings";
import BottomNav from "./components/BottomNav";
import { ConnectionBanner } from "./components/ConnectionBanner";
import DebugOverlay from "./components/DebugOverlay";
import SecretKeyBackupModal from "./components/SecretKeyBackupModal";
import OfflineQueueStatus from "./components/OfflineQueueStatus";

import {
  registerUser,
  getAuthToken,
  getCurrentUser,
  lockTrade,
  setAvailability,
  registerPushToken,
  notifyPaymentSent,
  type ProviderStatus,
  createTrade,
  fetchTradeDetail,
  getActiveTrades,
  getTrade,
  UserData,
  TradeData,
  TradeFlow,
  TradeHistoryItem,
} from "./services/api";
import { readJSON, writeJSON, removeKey, isBackupConfirmed, setBackupConfirmed } from "./services/secureStorage";
import { ApiError, mapApiError, type MappedApiError } from "./utils/apiError";
import { IS_DEMO_MODE } from "./utils/demoMode";
import { OPEN_TRADE_STATUSES, pickReusableTrade } from "./utils/reusableTrade";
import { DEFAULT_ESCROW_ASSET_KEY, getEscrowAssetOption } from "./constants/escrowAssets";
import { startPush, PUSH_PERMISSION_GRANTED_EVENT } from "./lib/push";

const USERS_STORAGE_KEY = "micopay_user";
/** WP3: id de la operacion en curso, para retomarla al recargar. */
const ACTIVE_TRADE_STORAGE_KEY = "micopay_active_trade_id";
/**
 * "Ya vio la explicacion del producto". Vive solo en el dispositivo: la
 * incorporacion de persona no cambia nada en el servidor, asi que guardarla
 * alli seria inventar un estado que no existe.
 */
const ONBOARDING_SEEN_KEY = 'micopay_onboarding_seen';

/**
 * Re-authenticate using the device keypair when a stored session is orphaned
 * (e.g. the backend DB was reset). The device key is the identity, so we can
 * re-register (fresh DB) or re-auth (user still exists) without user friction.
 */
async function recoverSession(username: string): Promise<UserData> {
  try {
    return await registerUser(username);
  } catch (e: unknown) {
    // registerUser throws an ApiError, not a raw Axios error, so the old
    // `e.response.status === 409` check never matched and recovery fell
    // through to a rethrow. Match on the backend code instead.
    if (e instanceof ApiError && e.code === 'ADDRESS_ALREADY_REGISTERED') {
      // This device already has an account — refresh the token instead.
      const token = await getAuthToken();
      const profile = await getCurrentUser(token);
      return { ...(profile as any), token } as UserData;
    }
    throw e;
  }
}


type Flow = "cashout" | "deposit" | null;

export interface AppCtx {
  /**
   * CASH-7 (#160 follow-up): una persona, una sesion. Antes habia dos campos
   * con nombre de rol y todos los caminos de alta, login y recuperacion les
   * asignaban EL MISMO objeto. Esos nombres conservaban el modelo viejo de
   * "un telefono, dos roles" y hacian que el campo del vendedor, por el mero
   * hecho de tener valor, significara "esta persona es proveedora".
   *
   * El rol es por operacion, no por sesion: se deriva del trade cargado
   * comparando `sessionUser.id` con `seller_id`/`buyer_id`.
   */
  sessionUser: UserData | null;
  /**
   * RED-1/RED-2: pertenencia a Red MicoPay, leida del servidor. Es un hecho
   * aparte de tener sesion — que era justo lo que la barra inferior confundia.
   * `null` mientras no se sabe; nunca se asume 'active'.
   */
  providerStatus: ProviderStatus | null;
  /** Vuelve a preguntar al servidor por la pertenencia (tras activarse, p. ej.). */
  refreshProviderStatus: () => Promise<void>;
  /** Disponibilidad comercial actual; solo significa algo si eres agente activo. */
  availability: string | null;
  /** Si ya vio la explicacion del producto. null mientras se averigua. */
  onboardingSeen: boolean | null;
  markOnboardingSeen: () => void;
  activeTrade: TradeData | null;
  lockTxHash: string | null;
  releaseTxHash: string | null;
  activeAmount: number;
  /** WP-C: activo elegido en la pantalla de monto (clave de ESCROW_ASSET_OPTIONS). */
  activeAssetKey: string;
  tradeLoading: boolean;
  tradeError: MappedApiError | null;
  flow: Flow;
  devicePublicKey: string | null;
  setActiveAmount: (n: number) => void;
  setActiveAssetKey: (key: string) => void;
  setFlow: (f: Flow) => void;
  setReleaseTxHash: (h: string | null) => void;
  handleOfferSelected: (offerId: string) => Promise<boolean>;
  handleDepositOfferSelected: (offerId: string) => Promise<boolean>;
  clearTradeError: () => void;
  retryTradeFlow: () => Promise<boolean>;
  /** WP3: crear una operacion nueva aunque haya una activa con ese agente. */
  allowNewTrade: () => void;
  handleAccountDeleted: () => void;
  resetTradeFlow: () => void;
  envName: string;
  backendUrl: string;
  isDemoMode: boolean;
  isMockStellar: boolean;
  backendConnected: boolean;
  backendHealth: any;
}

export const AppContext = createContext<AppCtx | null>(null);

function useAppCtx(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
}

// ── Route wrappers ───────────────────────────────────────────────────────────

function HomeRoute() {
  const navigate = useNavigate();
  const { sessionUser, setFlow, onboardingSeen } = useAppCtx();

  // Primera vez: se explica el producto antes de dejar tocar dinero. Solo
  // cuando ya se sabe que no lo ha visto — null significa "aun no se sabe".
  if (onboardingSeen === false) return <Navigate to="/welcome" replace />;

  return (
      <Home
          onNavigateCashout={() => { setFlow('cashout'); navigate('/cashout'); }}
          onNavigateDeposit={() => { setFlow('deposit'); navigate('/deposit'); }}
          onNavigateHistory={() => navigate('/history')}
          onNavigateBankWithdraw={BANK_WITHDRAW_ENABLED ? () => navigate('/retirar-banco') : undefined}
          token={sessionUser?.token ?? null}
          merchantToken={sessionUser?.token ?? null}
          onNavigateInbox={() => navigate('/inbox')}
          username={sessionUser?.username ?? null}
      />
  );
}

function HistoryRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  return (
      <History
          onBack={() => navigate('/')}
          onSelectTrade={(trade) => navigate(`/trade/${trade.id}`)}
          token={sessionUser?.token ?? null}
      />
  );
}

function TradeDetailRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  return (
    <TradeDetail
      token={sessionUser?.token ?? null}
      userId={sessionUser?.id ?? null}
      onBack={() => navigate('/history')}
    />
  );
}

function InboxRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionUser } = useAppCtx();
  return (
      <MerchantInbox
          token={sessionUser?.token ?? null}
          onBack={() => navigate('/')}
          onOpenTrade={(tradeId) => navigate(`/trade/${tradeId}`)}
          autoScan={Boolean((location.state as { autoScan?: boolean } | null)?.autoScan)}
      />
  );
}

function CashoutRoute() {
  const navigate = useNavigate();
  const { setActiveAmount, activeAssetKey, setActiveAssetKey } = useAppCtx();
  return (
      <CashoutRequest
          onBack={() => navigate('/')}
          assetKey={activeAssetKey}
          onAssetChange={setActiveAssetKey}
          onSearch={(amount) => {
            setActiveAmount(amount);
            navigate('/map');
          }}
      />
  );
}

function PayHubRoute() {
  const navigate = useNavigate();
  return (
      <PayHub
          onSend={() => navigate('/pay/send')}
          onReceive={() => navigate('/pay/receive')}
      />
  );
}

function SendPaymentRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  return (
      <SendPayment
          onBack={() => navigate('/pay')}
          onDone={() => navigate('/')}
          onSent={(r) => {
            // El pago ya salio; si el aviso falla no se le dice nada a quien envio.
            if (sessionUser?.token) notifyPaymentSent(r.hash, sessionUser.token).catch(() => {});
          }}
      />
  );
}

function ReceivePaymentRoute() {
  const navigate = useNavigate();
  const { devicePublicKey } = useAppCtx();
  return (
      <ReceivePayment
          address={devicePublicKey}
          onBack={() => navigate('/pay')}
      />
  );
}

function DepositRoute() {
  const navigate = useNavigate();
  const { setActiveAmount, activeAssetKey, setActiveAssetKey } = useAppCtx();
  return (
      <DepositRequest
          onBack={() => navigate('/')}
          assetKey={activeAssetKey}
          onAssetChange={setActiveAssetKey}
          onSearch={(amount) => {
            setActiveAmount(Number(amount) || 500);
            navigate('/map-deposit');
          }}
      />
  );
}

function MapDepositRoute() {
  const navigate = useNavigate();
  const { activeAmount, handleDepositOfferSelected, tradeLoading, tradeError, clearTradeError, retryTradeFlow } = useAppCtx();
  return (
      <DepositMap
          onBack={() => navigate('/deposit')}
          onProceedToConfirm={(offer) => {
            navigate('/confirm', {
              state: {
                merchantId: offer.id,
                merchantName: offer.name,
                receiveMxn: offer.receiveMxn,
                clientPaysMxn: offer.clientPaysMxn,
                commissionPct: offer.commissionPct,
                amountMxn: activeAmount,
                platformFeeMxn: offer.platformFeeMxn,
                providerFeeMxn: offer.providerFeeMxn,
                maxEffectiveFeePercent: offer.maxEffectiveFeePercent,
                flow: 'deposit',
                nearbyCount: offer.nearbyCount,
              },
            });
          }}
          onSelectOffer={async (offerId) => {
            const ok = await handleDepositOfferSelected(offerId);
            if (ok) navigate('/chat-deposit');
          }}
          loading={tradeLoading}
          creationError={tradeError?.message ?? null}
          creationErrorAction={tradeError?.action}
          onDismissCreationError={clearTradeError}
          onRetryCreationError={async () => {
            const ok = await retryTradeFlow();
            if (ok) navigate('/chat-deposit');
          }}
          onVerifyIdentity={() => navigate(`/kyc/didit?return=depositMap&level=${tradeError?.requiredLevel === 2 ? 2 : 1}`)}
      />
  );
}

function MapRoute() {
  const navigate = useNavigate();
  const { activeAmount, handleOfferSelected, tradeLoading, tradeError, clearTradeError, retryTradeFlow } = useAppCtx();
  return (
      <ExploreMap
          amount={activeAmount}
          loading={tradeLoading}
          onBack={() => navigate('/cashout')}
          onProceedToConfirm={(offer) => {
            navigate('/confirm', {
              state: {
                merchantId: offer.id,
                merchantName: offer.name,
                receiveMxn: offer.receiveMxn,
                clientPaysMxn: offer.clientPaysMxn,
                commissionPct: offer.commissionPct,
                amountMxn: activeAmount,
                platformFeeMxn: offer.platformFeeMxn,
                providerFeeMxn: offer.providerFeeMxn,
                maxEffectiveFeePercent: offer.maxEffectiveFeePercent,
                flow: 'cashout',
                nearbyCount: offer.nearbyCount,
              },
            });
          }}
          onSelectOffer={async (offerId) => {
            const ok = await handleOfferSelected(offerId);
            if (ok) navigate('/chat');
          }}
          creationError={tradeError?.message ?? null}
          creationErrorAction={tradeError?.action}
          onDismissCreationError={clearTradeError}
          onRetryCreationError={async () => {
            const ok = await retryTradeFlow();
            if (ok) navigate('/chat');
          }}
          onVerifyIdentity={() => navigate(`/kyc/didit?return=cashoutMap&level=${tradeError?.requiredLevel === 2 ? 2 : 1}`)}
      />
  );
}

function ConfirmRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const { handleOfferSelected, handleDepositOfferSelected, tradeLoading, tradeError, clearTradeError, activeAssetKey, allowNewTrade } =
    useAppCtx();
  const state = location.state as {
    merchantName: string;
    merchantId: string;
    receiveMxn: number;
    /** H5: lo que le cuesta al cliente (servidor). */
    clientPaysMxn?: number;
    commissionPct: number;
    amountMxn: number;
    // Desglose que ya calculo el servidor en el descubrimiento: se arrastra
    // hasta aqui para que la pantalla no vuelva a deducirlo restando.
    platformFeeMxn?: number;
    providerFeeMxn?: number;
    maxEffectiveFeePercent?: number;
    flow: 'cashout' | 'deposit';
    nearbyCount: number;
  } | null;

  if (!state?.merchantId) {
    return <Navigate to="/map" replace />;
  }

  // El deposito no tenia esta pantalla: al elegir agente saltaba directo al
  // chat, sin resumen. Los dos flujos comprometen dinero, asi que los dos
  // pasan por el mismo paso de revisar antes de aceptar.
  const isDeposit = state.flow === 'deposit';

  return (
    <TradeConfirmationPage
      merchantName={state.merchantName}
      merchantId={state.merchantId}
      receiveMxn={state.receiveMxn}
      clientPaysMxn={state.clientPaysMxn}
      commissionPct={state.commissionPct}
      amountMxn={state.amountMxn}
      platformFeeMxn={state.platformFeeMxn}
      providerFeeMxn={state.providerFeeMxn}
      maxEffectiveFeePercent={state.maxEffectiveFeePercent}
      flow={state.flow ?? 'cashout'}
      nearbyCount={state.nearbyCount}
      assetKey={activeAssetKey}
      loading={tradeLoading}
      errorMessage={tradeError?.message ?? null}
      errorAction={tradeError?.action}
      errorCode={tradeError?.error}
      onCreateNewInstead={allowNewTrade}
      onVerifyIdentity={() => navigate(`/kyc/didit?return=${isDeposit ? 'depositMap' : 'cashoutMap'}&level=${tradeError?.requiredLevel === 2 ? 2 : 1}`)}
      onChooseAnotherAgent={() => {
        clearTradeError();
        navigate('/map');
      }}
      onBack={() => {
        clearTradeError();
        navigate(-1);
      }}
      onConfirm={async () => {
        const ok = isDeposit
          ? await handleDepositOfferSelected(state.merchantId)
          : await handleOfferSelected(state.merchantId);
        if (ok) navigate(isDeposit ? '/chat-deposit' : '/chat');
        return ok;
      }}
    />
  );
}

/** Counterparty display name and cash-out role for ChatRoom banners. */
function useTradeParticipantInfo(activeTrade: TradeData | null, sessionUser: UserData | null) {
  const [counterpartyName, setCounterpartyName] = useState<string | null>(null);
  const [isProvider, setIsProvider] = useState(false);
  const [flow, setFlow] = useState<TradeFlow | null>(null);

  useEffect(() => {
    if (!activeTrade || !sessionUser?.token) return;
    fetchTradeDetail(activeTrade.id, sessionUser.token)
      .then(({ trade, seller_username, buyer_username }) => {
        setFlow(trade.flow === 'cashout' ? 'cashout' : 'deposit');
        const isMeTheEscrowSeller = trade.seller_id === sessionUser.id;
        setCounterpartyName(isMeTheEscrowSeller ? buyer_username : seller_username);
        // Cash-out (/chat): the client locks crypto (escrow seller); the agent
        // hands over cash (escrow buyer). isProvider marks the agent view.
        // `provider_id` decides when present, so a deposit agent is right too.
        setIsProvider(trade.provider_id ? trade.provider_id === sessionUser.id : !isMeTheEscrowSeller);
      })
      .catch(() => {});
  }, [activeTrade, sessionUser?.token, sessionUser?.id]);

  return { counterpartyName, isProvider, flow };
}

function ChatRoute() {
  const navigate = useNavigate();
  const { lockTxHash, activeTrade, sessionUser } = useAppCtx();
  // #3: desde el detalle la operacion llega en la ruta. El agente no tiene
  // `activeTrade` en memoria, asi que su chat salia vacio.
  const { tradeId: routeTradeId } = useParams();
  const routeTrade = useMemo(() => (routeTradeId ? ({ id: routeTradeId } as TradeData) : null), [routeTradeId]);
  const chatTrade = routeTrade ?? activeTrade;
  const { counterpartyName, isProvider, flow } = useTradeParticipantInfo(chatTrade, sessionUser);
  return (
      <ChatRoom
          tradeId={chatTrade?.id ?? ''}
          userId={sessionUser?.id ?? ''}
          token={sessionUser?.token}
          apiBaseUrl={import.meta.env.VITE_API_URL}
          lockTxHash={lockTxHash}
          counterpartyName={counterpartyName}
          isProvider={isProvider}
          onBack={() => navigate(routeTradeId ? `/trade/${routeTradeId}` : '/map')}
          // En un deposito el QR del cliente es otra pantalla (`DepositQR`).
          onViewQR={() => navigate(routeTradeId && flow === 'deposit' ? `/qr-deposit/${routeTradeId}` : '/qr-reveal')}
          onScan={() => navigate('/inbox', { state: { autoScan: true } })}
      />
  );
}

function ChatDepositRoute() {
  const navigate = useNavigate();
  const { lockTxHash, activeTrade, sessionUser } = useAppCtx();
  const { counterpartyName } = useTradeParticipantInfo(activeTrade, sessionUser);
  return (
      <DepositChat
          tradeId={activeTrade?.id ?? ''}
          userId={sessionUser?.id ?? ''}
          token={sessionUser?.token}
          apiBaseUrl={import.meta.env.VITE_API_URL}
          lockTxHash={lockTxHash}
          counterpartyName={counterpartyName}
          onBack={() => navigate('/map-deposit')}
          onViewQR={() => navigate('/qr-deposit')}
      />
  );
}

function QRRevealRoute() {
  const navigate = useNavigate();
  const { activeTrade, sessionUser } = useAppCtx();
  const { counterpartyName } = useTradeParticipantInfo(activeTrade, sessionUser);

  return (
      <QRReveal
          activeTrade={activeTrade}
          token={sessionUser?.token ?? null}
          viewerId={sessionUser?.id ?? null}
          counterpartyName={counterpartyName}
          ownName={sessionUser?.username ?? null}
          onBack={() => navigate('/chat')}
          onChat={() => navigate('/chat')}
          onSuccess={() => navigate('/success')}
      />
  );
}

function QRDepositRoute() {
  const navigate = useNavigate();
  const { activeTrade, sessionUser } = useAppCtx();
  // Desde el detalle o el chat la operacion llega en la ruta: ahi esta el
  // reclamo "Pague y no me confirmaron".
  const { tradeId: routeTradeId } = useParams();
  const routeTrade = useMemo(() => (routeTradeId ? ({ id: routeTradeId } as TradeData) : null), [routeTradeId]);
  return (
      <DepositQR
          activeTrade={routeTrade ?? activeTrade}
          buyerToken={sessionUser?.token ?? null}
          viewerId={sessionUser?.id ?? null}
          onBack={() => navigate(routeTradeId ? `/trade/${routeTradeId}` : '/chat-deposit')}
          onChat={() => navigate(routeTradeId ? `/chat/${routeTradeId}` : '/chat-deposit')}
          onSuccess={() => navigate('/success')}
      />
  );
}

function SuccessRoute() {
  const navigate = useNavigate();
  const { flow, activeTrade, lockTxHash, releaseTxHash, sessionUser, resetTradeFlow } = useAppCtx();
  const [receipt, setReceipt] = useState<SuccessReceipt | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Block access if there is no real active trade
  useEffect(() => {
    if (!activeTrade) {
      navigate('/', { replace: true });
      return;
    }

    if (sessionUser?.token) {
      fetchTradeDetail(activeTrade.id, sessionUser.token)
        .then(({ trade, seller_username, buyer_username }) => {
          // WP-D: el recibo se pinta con la operacion del servidor. Antes esta
          // respuesta se guardaba y luego se descartaba: la pantalla recibia un
          // objeto armado con el monto local, comisiones de 1%/0.8% sin
          // redondeo y fechas nuevas.
          setReceipt(receiptFromServer(trade, lockTxHash, releaseTxHash));
          // El agente es el PROVEEDOR. En cash-out el seller del escrow es el
          // cliente, asi que `seller_username` era el nombre de la propia persona.
          setAgentName(trade.provider_id === trade.seller_id ? seller_username : buyer_username);
        })
        .catch((e) => {
          console.warn('Could not fetch trade detail for receipt', e);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [activeTrade, sessionUser?.token, lockTxHash, releaseTxHash, navigate]);

  if (!activeTrade) return null;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-fondo">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
      <SuccessScreen
          type={flow === 'cashout' ? 'cashout' : 'deposit'}
          // Si el detalle no llego, el respaldo es la operacion que devolvio
          // POST /trades, sin comisiones ni fechas inventadas: lo que no se sabe
          // se oculta en la pantalla.
          trade={receipt ?? receiptFromServer(activeTrade, lockTxHash, releaseTxHash)}
          viewerId={sessionUser?.id ?? null}
          agentName={agentName}
          onHome={() => {
            resetTradeFlow();
            navigate('/');
          }}
      />
  );
}

function ExploreRoute() {
  const navigate = useNavigate();
  const { isDemoMode, isMockStellar } = useAppCtx();
  const navMap: Record<string, string> = {
    home: "/",
    cashout: "/cashout",
    deposit: "/deposit",
    cetes: "/cetes",
    blend: "/blend",
    explore: "/explore",
    profile: "/profile",
    inbox: "/inbox",
    history: "/history",
  };
  return (
      <Explore
          onBack={() => navigate('/')}
          onNavigate={(page) => navigate(navMap[page] ?? '/')}
          // Apagados se muestran como "Próximamente" (constants/features.ts).
          cetesAvailable={CETES_AVAILABLE}
          blendAvailable={BLEND_AVAILABLE}
      />
  );
}

function CetesRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  const { t } = useTranslation();
  // Tambien se llega por la barra inferior ("Invertir"), por URL y por el
  // regreso del KYC: todas pasan por aqui.
  if (!CETES_AVAILABLE) {
    return <ComingSoon title={t('exploreScreen.investCetes')} icon="trending_up" onBack={() => navigate('/explore')} />;
  }
  return (
      <CETESScreen
          onBack={() => navigate('/explore')}
          // "¿Sin cripto?" without approved KYC: KYC is the actual prerequisite
          // for the Etherfuse SPEI ramp (see canDepositSpei in CETESScreen), not
          // the P2P cash-agent flow at /deposit — that CTA used to send users
          // there by mistake.
          onBanco={() => navigate('/kyc')}
          userToken={sessionUser?.token}
          showDefi={DEFI_TRADING_ENABLED}
          showSpeiRamp={SPEI_RAMP_ENABLED}
      />
  );
}

function BankWithdrawRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  if (!BANK_WITHDRAW_ENABLED || !sessionUser?.token) {
    return <ComingSoon title="Retirar a banco" icon="account_balance" onBack={() => navigate('/')} />;
  }
  return (
    <BankWithdrawScreen
      onBack={() => navigate('/')}
      onVerifyIdentity={() => navigate('/kyc/didit?return=bankWithdraw')}
      userToken={sessionUser.token}
    />
  );
}

/**
 * KYC-1: destinos de retorno permitidos.
 *
 * Al aprobar hay que volver a lo que el usuario estaba haciendo, pero ese
 * destino NO puede salir tal cual de la URL: seria un redirect abierto a
 * cualquier sitio. Se acepta solo una etiqueta de esta lista.
 */
const KYC_RETURN_DESTINATIONS = {
  cetes: '/cetes',
  home: '/',
  explore: '/explore',
  inbox: '/inbox',
  profile: '/profile',
  joinNetwork: '/join-network',
  bankWithdraw: '/retirar-banco',
  cashoutMap: '/map',
  depositMap: '/map-deposit',
} as const;

type KycReturnKey = keyof typeof KYC_RETURN_DESTINATIONS;

function resolveKycReturn(raw: string | null, fallback: KycReturnKey): string {
  if (raw && raw in KYC_RETURN_DESTINATIONS) {
    return KYC_RETURN_DESTINATIONS[raw as KycReturnKey];
  }
  return KYC_RETURN_DESTINATIONS[fallback];
}

/**
 * KYC-1: KYC general de MicoPay (Didit), el que exigen las operaciones P2P.
 *
 * Antes solo existia `/kyc`, que abria el proveedor por omision —Etherfuse— y
 * devolvia a CETES. Un error de nivel en una operacion P2P no tenia forma de
 * abrir Didit, asi que el KYC general no era un recorrido completo.
 */
export function DiditKYCRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  const [params] = useSearchParams();
  const destination = resolveKycReturn(params.get('return'), 'home');
  const level = params.get('level') === '2' ? 2 : 1;
  return (
      <KYCScreen
          token={sessionUser?.token ?? null}
          provider="didit"
          level={level}
          onApproved={() => {
            navigate(destination);
          }}
      />
  );
}

/**
 * KYC-1: KYC del anchor (Etherfuse), exclusivo de CETES/SPEI. Conserva el
 * retorno a CETES de #355.
 */
export function KYCRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  const [params] = useSearchParams();
  // Sin CETES abierto no hay a donde volver ahi: se vuelve al inicio.
  const destination = resolveKycReturn(params.get('return'), CETES_AVAILABLE ? 'cetes' : 'home');
  return (
      <KYCScreen
          token={sessionUser?.token ?? null}
          provider="etherfuse"
          onApproved={() => {
            navigate(destination);
          }}
      />
  );
}

function KYCApprovedNextRoute() {
  const navigate = useNavigate();
  // Tras aprobar, sigue a CETES si esta abierto; si no, al inicio.
  useEffect(() => {
    navigate(CETES_AVAILABLE ? '/cetes' : '/');
  }, [navigate]);
  return null;
}


function BlendRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  const { t } = useTranslation();
  if (!BLEND_AVAILABLE) {
    return <ComingSoon title={t('exploreScreen.requestLoan')} icon="account_balance" onBack={() => navigate('/explore')} />;
  }
  return (
      <BlendScreen
          onBack={() => navigate('/explore')}
          userToken={sessionUser?.token}
      />
  );
}

/**
 * Incorporacion de persona. No toca el servidor: lo unico que persiste es el
 * "ya visto", y en el dispositivo, porque es comprension y no un estado del
 * sistema.
 */
function WelcomeRoute() {
  const navigate = useNavigate();
  const { sessionUser, markOnboardingSeen } = useAppCtx();
  const done = () => {
    markOnboardingSeen();
    navigate('/', { replace: true });
  };
  return (
      <Welcome
          username={sessionUser?.username ?? null}
          onDone={done}
          onBackupKey={IS_EXTERNAL_SIGNER ? undefined : () => navigate('/profile')}
      />
  );
}

/** Incorporacion de agente. Esta SI cambia estado real en el servidor. */
export function ProviderOnboardingRoute() {
  const navigate = useNavigate();
  const { sessionUser, refreshProviderStatus } = useAppCtx();
  return (
      <ProviderOnboarding
          token={sessionUser?.token ?? ''}
          onExit={() => navigate('/profile')}
          onOpenKyc={() => navigate('/kyc/didit?return=joinNetwork')}
          onOpenSettings={() => navigate('/merchant-settings')}
          onActivated={() => { void refreshProviderStatus(); }}
      />
  );
}

function ProfileRoute() {
  const navigate = useNavigate();
  // devicePublicKey must be destructured here — referencing it from outer
  // scope would silently be undefined inside this component
  const { sessionUser, handleAccountDeleted, devicePublicKey, providerStatus, availability, refreshProviderStatus } = useAppCtx();
  return (
      <Profile
          token={sessionUser?.token ?? null}
          username={sessionUser?.username ?? null}
          devicePublicKey={devicePublicKey}
          onBack={() => navigate('/')}
          onDeleted={() => {
            handleAccountDeleted();
            navigate('/');
          }}
          onLogout={() => {
            handleAccountDeleted();
            navigate('/login');
          }}
          onNavigatePrivacy={() => navigate('/privacy')}
          onNavigateTerms={() => navigate('/terms')}
          onNavigateKyc={() => navigate('/kyc/didit?return=profile')}
          onNavigateJoinNetwork={() => navigate('/join-network')}
          onNavigateMerchantSettings={() => navigate('/merchant-settings')}
          providerStatus={providerStatus}
          availability={availability}
          onToggleAvailability={async (next) => {
            if (!sessionUser?.token) return;
            // El servidor rechaza esto si no eres agente activo; la interfaz
            // solo lo ofrece cuando lo eres, pero la verdad la aplica el.
            await setAvailability(next, sessionUser.token).catch(() => {});
            await refreshProviderStatus();
          }}
      />
  );
}

function MerchantSettingsRoute() {
  const navigate = useNavigate();
  const { sessionUser } = useAppCtx();
  return (
    <MerchantSettings
      token={sessionUser?.token ?? null}
      onBack={() => navigate('/')}
    />
  );
}

function PrivacyRoute() {
  const navigate = useNavigate();
  return <Privacy onBack={() => navigate("/profile")} />;
}

function TermsRoute() {
  const navigate = useNavigate();
  return <Terms onBack={() => navigate("/profile")} />;
}

function SignatureApprovalRoute() {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const location = useLocation();
  const { sessionUser } = useAppCtx();
  const searchParams = new URLSearchParams(location.search);
  const requestId = id || searchParams.get('id') || undefined;

  return (
    <SignatureApproval
      requestId={requestId}
      token={sessionUser?.token}
      onBack={() => navigate('/')}
      onResolved={() => {
        setTimeout(() => navigate('/'), 2000);
      }}
    />
  );
}

// ── Route wrappers (auth) ───────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: React.ReactElement }) {
  const { sessionUser } = useAppCtx();
  const location = useLocation();

  if (!sessionUser) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}

// ── BottomNav route adapter ──────────────────────────────────────────────────

const ROUTE_TO_PAGE: Record<string, string> = {
  "/": "home",
  "/pay": "pay",
  "/inbox": "inbox",
  "/explore": "explore",
  "/cetes": "cetes",
  "/profile": "profile",
};

const HIDE_BOTTOMNAV_ROUTES = new Set([
  "/login",
  "/register",
  "/welcome",
  "/join-network",
  "/merchant-settings",
  "/confirm",
  "/chat",
  "/chat-deposit",
  "/qr-reveal",
  "/qr-deposit",
  "/success",
  "/cashout",
  "/pay/send",
  "/pay/receive",
  "/blend",
  "/privacy",
  "/terms",
  "/sign-request",
]);

// The signing screen is a standalone deep-link UI.
const HIDE_BOTTOMNAV_PREFIX = ['/sign-request/'];

function BottomNavAdapter() {
  const navigate = useNavigate();
  const location = useLocation();
  const { providerStatus } = useAppCtx();

  if (HIDE_BOTTOMNAV_ROUTES.has(location.pathname)) return null;

  const navMap: Record<string, string> = {
    home: "/",
    pay: "/pay",
    inbox: "/inbox",
    explore: "/explore",
    cetes: "/cetes",
    profile: "/profile",
  };

  return (
      <BottomNav
          currentPage={ROUTE_TO_PAGE[location.pathname] ?? location.pathname.slice(1)}
          onNavigate={(page) => navigate(navMap[page] ?? '/')}
          // RED-2: atado al estado real de pertenencia. Antes esto era
          // `!!sessionUser`, o sea "hay sesion" disfrazado de "es proveedora":
          // toda cuenta autenticada veia la superficie de agente. Mientras el
          // estado se desconoce (null) la pestana no se muestra, que es el lado
          // seguro del error.
          showProviderTab={providerStatus === 'active'}
      />
  );
}

// ── Armazon de la web en PC ──────────────────────────────────────────────────

const NAV_ROUTES: Record<string, string> = {
  home: "/",
  pay: "/pay",
  inbox: "/inbox",
  explore: "/explore",
  cetes: "/cetes",
  profile: "/profile",
};

const HIDE_WEB_SIDEBAR_ROUTES = new Set(["/login", "/register", "/welcome"]);

function AppFrame({ children }: { children: React.ReactNode }) {
  if (!IS_EXTERNAL_SIGNER) {
    return <div className="flex flex-col min-h-screen bg-fondo">{children}</div>;
  }
  return <WebFrame>{children}</WebFrame>;
}

function WebFrame({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { sessionUser, providerStatus } = useAppCtx();
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionUser) { setAddress(null); return; }
    getPublicKey().then(setAddress).catch(() => setAddress(null));
  }, [sessionUser]);

  const operation: WebNavItem[] = [
    { page: 'home', icon: 'home', label: t('nav.home') },
    { page: 'pay', icon: 'swap_horiz', label: t('nav.pay') },
    ...(providerStatus === 'active' ? [{ page: 'inbox', icon: 'inbox', label: t('nav.inbox') }] : []),
    { page: 'cetes', icon: 'savings', label: t('nav.invest') },
    { page: 'explore', icon: 'explore', label: t('nav.explore') },
  ];

  return (
    <WebShell
      showSidebar={!!sessionUser && !HIDE_WEB_SIDEBAR_ROUTES.has(location.pathname)}
      operation={operation}
      account={[{ page: 'profile', icon: 'person', label: t('nav.profile') }]}
      currentPage={ROUTE_TO_PAGE[location.pathname] ?? ''}
      onNavigate={(page) => navigate(NAV_ROUTES[page] ?? '/')}
      username={sessionUser?.username}
      address={address}
    >
      {children}
      <WebScanDialog />
    </WebShell>
  );
}

// ── Push notifications ───────────────────────────────────────────────────────
// Con sesion, registra el telefono para recibir avisos y abre la pantalla del
// aviso que se toco. El permiso se pide aqui, una vez, al entrar; si se niega,
// la bandeja del agente explica como activarlo.
function PushNotificationsBridge() {
  const { sessionUser } = useAppCtx();
  const navigate = useNavigate();
  const token = sessionUser?.token ?? null;
  // Sube cuando la persona da permiso desde la bandeja: vuelve a registrar.
  const [permissionTick, setPermissionTick] = useState(0);

  useEffect(() => {
    const onGranted = () => setPermissionTick((n) => n + 1);
    window.addEventListener(PUSH_PERMISSION_GRANTED_EVENT, onGranted);
    return () => window.removeEventListener(PUSH_PERMISSION_GRANTED_EVENT, onGranted);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let cleanup = () => {};
    startPush({
      askPermission: permissionTick === 0,
      onToken: (pushToken) => {
        // Si falla, se reintenta la proxima vez que abra la app: el token se
        // vuelve a entregar en cada registro.
        registerPushToken(pushToken, token).catch((err) => {
          console.warn('[push] No se pudo guardar el token', err);
        });
      },
      onOpen: (route) => navigate(route),
    })
      .then((stop) => {
        if (cancelled) stop();
        else cleanup = stop;
      })
      .catch((err) => console.warn('[push] No se pudieron activar los avisos', err));
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [token, navigate, permissionTick]);

  return null;
}

// ── Connection banner host ───────────────────────────────────────────────────
// Tracks browser/WebView online-offline state directly (navigator.onLine +
// the online/offline events) — deliberately independent of the merchant
// offline-mutation queue (services/offlineQueue*.ts), which is a different,
// narrower concern (queueing merchant config writes) than "is this device
// connected to the internet at all".
function ConnectionBannerHost() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return <ConnectionBanner isVisible={!isOnline} message="Sin conexión a internet" />;
}

// ── Root App ─────────────────────────────────────────────────────────────────

function App() {
  const [flow, setFlow] = useState<Flow>(null);
  const [sessionUser, setSessionUser] = useState<UserData | null>(null);

  // La APK atiende firmas de la web solo con sesion abierta.
  useEffect(() => {
    if (!sessionUser?.token) {
      stopWalletRequests();
      return;
    }
    startWalletConnect(sessionUser.token).catch((err) => console.error("[WalletConnect]", err));
  }, [sessionUser?.token]);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [availability, setAvailabilityState] = useState<string | null>(null);
  // null = todavia no se sabe. Mientras no se sepa NO se redirige a nada: hacerlo
  // provocaria un parpadeo del onboarding a quien ya lo vio.
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);

  useEffect(() => {
    readJSON<{ seen?: boolean }>(ONBOARDING_SEEN_KEY)
      .then((v) => setOnboardingSeen(v?.seen === true))
      .catch(() => setOnboardingSeen(true)); // ante la duda, no molestar
  }, []);

  /**
   * RED-1: la pertenencia a Red MicoPay se lee del servidor, nunca se deduce.
   * Si la consulta falla no se inventa un estado: se deja en null y la interfaz
   * de agente permanece oculta, que es el lado seguro del error.
   */
  const refreshProviderStatus = useCallback(async () => {
    const token = sessionUser?.token;
    if (!token) {
      setProviderStatus(null);
      setAvailabilityState(null);
      return;
    }
    try {
      const profile = await getCurrentUser(token);
      setProviderStatus((profile.provider_status as ProviderStatus | undefined) ?? 'not_enrolled');
      setAvailabilityState(profile.availability ?? null);
    } catch {
      setProviderStatus(null);
      setAvailabilityState(null);
    }
  }, [sessionUser?.token]);

  // Cada vez que hay (o deja de haber) sesion, se vuelve a preguntar.
  useEffect(() => {
    void refreshProviderStatus();
  }, [refreshProviderStatus]);
  const [activeTrade, setActiveTrade] = useState<TradeData | null>(null);
  const [lockTxHash, setLockTxHash] = useState<string | null>(null);
  const [releaseTxHash, setReleaseTxHash] = useState<string | null>(null);
  const [activeAmount, setActiveAmount] = useState(500);
  const [activeAssetKey, setActiveAssetKey] = useState(DEFAULT_ESCROW_ASSET_KEY);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeError, setTradeError] = useState<MappedApiError | null>(null);
  const [pendingSellerId, setPendingSellerId] = useState<string | null>(null);
  // CASH-1 (#372): the retried value is the product flow, not the escrow role.
  const [pendingFlow, setPendingFlow] = useState<TradeFlow>('deposit');
  // WP3: operacion ya creada cuyo bloqueo fallo. Reintentar bloquea ESA, no
  // crea otra (cada reintento dejaba una operacion fantasma).
  const lockRetryRef = useRef<{ tradeId: string; counterpartyId: string; flow: TradeFlow } | null>(null);
  // WP3: operacion activa que ya se le ofrecio retomar. Confirmar otra vez la acepta.
  const resumeOfferRef = useRef<string | null>(null);
  // WP3: la persona eligio "Crear otra operación" en vez de retomar.
  const forceNewTradeRef = useRef(false);
  const allowNewTrade = () => {
    forceNewTradeRef.current = true;
    resumeOfferRef.current = null;
    setTradeError(null);
  };
  const [authReady, setAuthReady] = useState(false);
  const [devicePublicKey, setDevicePublicKey] = useState<string | null>(null);

  const [showBackupPrompt, setShowBackupPrompt] = useState(false);
  const [pendingTradeContext, setPendingTradeContext] = useState<{ resolve: (val: boolean) => void, execute: () => Promise<boolean> } | null>(null);
  const [backupSecret, setBackupSecret] = useState<string>('');

  const [startupError, setStartupError] = useState<{ title: string; message: string; details?: string } | null>(null);
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendHealth, setBackendHealth] = useState<any>(null);
  const [isDemoMode, setIsDemoMode] = useState(true);
  const [isMockStellar, setIsMockStellar] = useState(true);
  const [backendUrl, setBackendUrl] = useState("");
  const envName = import.meta.env.MODE;
  /** Modos que operan contra dinero real: nunca deben caer a mocks. */
  const STRICT_STARTUP_MODES = new Set(['production', 'mainnet']);

  useEffect(() => {
    const initUsers = async () => {
      // 1. Validate VITE_API_URL existence
      const apiUrl = import.meta.env.VITE_API_URL;
      if (!apiUrl) {
        setStartupError({
          title: "Configuración de API Faltante",
          message: "La variable de entorno VITE_API_URL no está configurada.",
          details: "El APK requiere VITE_API_URL para ubicar el backend. Asegúrate de configurar un archivo .env válido (ej. .env.testnet)."
        });
        setAuthReady(true);
        return;
      }

      setBackendUrl(apiUrl);

      // 2. Fetch backend health and validate contract config
      let connected = false;
      let mockStellarActive = true;
      try {
        const response = await fetch(`${apiUrl}/health`);
        if (!response.ok) {
          throw new Error(`HTTP Error ${response.status}`);
        }
        const health = await response.json();
        connected = true;
        setBackendConnected(true);
        setBackendHealth(health);
        
        mockStellarActive = health.mockStellar ?? false;
        setIsMockStellar(mockStellarActive);
        
        // If running in normal (non-mock) mode, verify critical configs
        if (!mockStellarActive) {
          const configCheck = health.configCheck ?? {};
          if (!configCheck.hasPlatformKey || !configCheck.hasContractId) {
            setStartupError({
              title: "Configuración del Contrato Incompleta",
              message: "El servidor de Micopay está en modo real (normal), pero le faltan configuraciones críticas de Stellar o contratos.",
              details: "Verifica que el backend tenga PLATFORM_SECRET_KEY y ESCROW_CONTRACT_ID configuradas y válidas."
            });
            setAuthReady(true);
            return;
          }
          setIsDemoMode(false);
        } else {
          setIsDemoMode(true);
        }
      } catch (err) {
        console.warn("Backend not reachable during startup:", err);
        setBackendConnected(false);
        
        // Bloquear si el backend está caído. `build:mainnet` compila con
        // --mode mainnet, así que MODE es 'mainnet', no 'production': sin
        // incluirlo, el APK de mainnet caía a mocks en silencio
        // (docs/AUDIT_MOBILE_MAINNET.md §3).
        if (STRICT_STARTUP_MODES.has(envName)) {
          setStartupError({
            title: "Servidor Inalcanzable",
            message: "No se pudo conectar al servidor de Micopay.",
            details: `La aplicación está en modo producción e intenta conectar a: ${apiUrl}. Por favor verifica tu conexión a internet o el estado del servidor.`
          });
          setAuthReady(true);
          return;
        } else {
          // Dev/Testnet builds fallback gracefully to local demo mocks if offline
          setIsDemoMode(true);
          setIsMockStellar(true);
        }
      }

      // 3. Authenticate and register user
      try {
        // Always load the keypair first — registerUser reads it to get the
        // Stellar address, so this must happen before any registerUser call.
        if (!await keypairExists()) {
          if (import.meta.env.VITE_DEMO_MODE === 'true') {
            await generateAndStoreKeypair();
          } else {
            setDevicePublicKey(null);
            await removeKey(USERS_STORAGE_KEY);
            return;
          }
        }
        const pubKey = await getPublicKey();
        setDevicePublicKey(pubKey);

        const stored = await readJSON<UserData>(USERS_STORAGE_KEY);
        if (stored?.id && stored.token) {
          // Validate the stored session; self-heal if the backend no longer
          // knows this user (e.g. its DB was recreated → orphaned token → 401).
          try {
            const profile = await getCurrentUser(stored.token);
            // Self-heal stale sessions cached with the wrong id (older builds
            // stored the username as `id` instead of the real backend user id).
            const fresh: UserData = { id: profile.id, username: profile.username, token: stored.token };
            if (fresh.id !== stored.id) await writeJSON(USERS_STORAGE_KEY, fresh);
            setSessionUser(fresh);
            return;
          } catch (err: any) {
            const status = err?.response?.status;
            if (IS_EXTERNAL_SIGNER && (status === 401 || status === 403)) {
              // En la web recuperar pediria una firma al abrir la pagina.
              await removeKey(USERS_STORAGE_KEY);
              return;
            }
            if (status !== 401 && status !== 403) {
              // Transient/network error — keep the cached session optimistically.
              setSessionUser(stored);
              return;
            }
            try {
              const recovered = await recoverSession(stored.username);
              await writeJSON(USERS_STORAGE_KEY, recovered);
              setSessionUser(recovered);
              return;
            } catch (re) {
              console.warn("Session recovery failed; clearing stale session", re);
              await removeKey(USERS_STORAGE_KEY);
              // fall through → empty session → ProtectedRoute redirects to login
            }
          }
        }

        // Demo builds auto-provision one throwaway user. In real mode we
        // leave the session empty so ProtectedRoute redirects to login/register.
        if (import.meta.env.VITE_DEMO_MODE === 'true') {
          const ts = Date.now() % 100000;
          const user = await registerUser(`demo_${ts}`);
          await writeJSON(USERS_STORAGE_KEY, user);
          setSessionUser(user);
        }
      } catch (e) {
        console.warn("Backend unavailable for registration, using local stub", e);
      } finally {
        setAuthReady(true);
      }
    };

    initUsers();
  }, []);

  const handleLoginSuccess = (user: UserData) => {
    setSessionUser(user);
    writeJSON(USERS_STORAGE_KEY, user);
  };

  const handleAccountDeleted = () => {
    if (IS_EXTERNAL_SIGNER) void import('./lib/signer/externalSigner').then((signer) => signer.disconnectWallet());
    setSessionUser(null);
    setActiveTrade(null);
    setLockTxHash(null);
    setReleaseTxHash(null);
    setFlow(null);
    void removeKey(USERS_STORAGE_KEY);
  };

  const resetTradeFlow = () => {
    setFlow(null);
    setActiveAssetKey(DEFAULT_ESCROW_ASSET_KEY);
    setActiveTrade(null);
    setLockTxHash(null);
    setReleaseTxHash(null);
  };

  const clearTradeError = () => setTradeError(null);

  // WP3: `activeTrade` vive en memoria; al recargar se perdia y las pantallas
  // mostraban un QR sin operacion. Se guarda el id y se restaura del servidor.
  const restoredTradeRef = useRef(false);
  useEffect(() => {
    if (IS_DEMO_MODE) return;
    if (activeTrade?.id) void writeJSON(ACTIVE_TRADE_STORAGE_KEY, activeTrade.id).catch(() => {});
    // Antes de restaurar no se borra: al montar `activeTrade` siempre es null.
    else if (restoredTradeRef.current) void removeKey(ACTIVE_TRADE_STORAGE_KEY).catch(() => {});
  }, [activeTrade?.id]);

  useEffect(() => {
    const token = sessionUser?.token;
    if (!token || activeTrade || restoredTradeRef.current || IS_DEMO_MODE) return;
    restoredTradeRef.current = true;
    void (async () => {
      const storedId = await readJSON<string>(ACTIVE_TRADE_STORAGE_KEY).catch(() => null);
      if (!storedId) return;
      const trade = await getTrade(storedId, token).catch(() => null);
      if (trade && OPEN_TRADE_STATUSES.includes(trade.status)) {
        setActiveTrade((prev) => prev ?? trade);
        if (trade.lock_tx_hash) setLockTxHash((prev) => prev ?? trade.lock_tx_hash ?? null);
      }
    })();
  }, [sessionUser?.token, activeTrade]);

  /** WP3: la operacion que ya existe para este agente y flujo, si la hay. */
  const findReusableTrade = async (counterpartyId: string, tradeFlow: TradeFlow, token: string) => {
    const pendingRetry = lockRetryRef.current;
    const retry = pendingRetry && pendingRetry.counterpartyId === counterpartyId && pendingRetry.flow === tradeFlow
      ? await getTrade(pendingRetry.tradeId, token).catch(() => null)
      : null;
    if (!retry || retry.status !== 'pending') lockRetryRef.current = null;
    const active = await getActiveTrades(token).catch(() => [] as TradeData[]);
    return pickReusableTrade({
      retry, active, counterpartyId, flow: tradeFlow, amountMxn: activeAmount, acceptedOfferId: resumeOfferRef.current,
    });
  };

  const runTradeFlow = async (counterpartyId: string, tradeFlow: TradeFlow = 'deposit'): Promise<boolean> => {
    if (!sessionUser) return false;
    setPendingSellerId(counterpartyId);
    setPendingFlow(tradeFlow);
    setTradeLoading(true);
    setTradeError(null);
    try {
      const forceNew = forceNewTradeRef.current;
      forceNewTradeRef.current = false;
      const { trade: reusable, conflict, offer } = forceNew
        ? { trade: null, conflict: null, offer: null }
        : await findReusableTrade(counterpartyId, tradeFlow, sessionUser.token);
      if (offer) {
        // Se ofrece, no se decide por la persona: el segundo intento la acepta.
        resumeOfferRef.current = offer.id;
        const message = `Ya tienes una operación activa de $${offer.amount_mxn} MXN con este agente. Confirma de nuevo para retomarla, o crea otra.`;
        setTradeError({ ...mapApiError(new Error(message)), message, action: 'retry', error: 'ACTIVE_TRADE_OFFER' });
        return false;
      }
      resumeOfferRef.current = null;
      if (conflict) {
        const message = `Ya tienes una operación activa de $${conflict.amount_mxn} MXN con este agente. Puedes abrirla desde tu actividad, o crear otra.`;
        setTradeError({ ...mapApiError(new Error(message)), message, error: 'ACTIVE_TRADE_OFFER' });
        return false;
      }
      // WP-C: el codigo del activo elegido. Si la clave no existe en el
      // catalogo no se envia nada y el servidor aplica su default (XLM); una
      // opcion deshabilitada no se puede elegir en el selector.
      const assetCode = getEscrowAssetOption(activeAssetKey)?.code;
      const trade = reusable ?? await createTrade(counterpartyId, activeAmount, sessionUser.token, tradeFlow, assetCode);
      setActiveTrade(trade);

      // Confirmar ES autorizar: el bloqueo se dispara aqui, en el mismo gesto,
      // y la huella sale dentro de `lockTrade`.
      //
      // Antes el bloqueo solo ocurria al tocar "Ver mi QR de operacion", en otra
      // pantalla. Mientras tanto el chat mostraba "Estamos bloqueando tu saldo
      // en cadena, espera la confirmacion" — sin que hubiera NADA en marcha. La
      // persona esperaba indefinidamente algo que nadie habia empezado, y eso
      // se reporto como "el escrow se queda en espera".
      //
      // Solo en cash-out: ahi la persona es la vendedora del escrow y es su
      // dinero el que se bloquea. En deposito bloquea el agente, no ella.
      if (tradeFlow === 'cashout' && trade.status === 'pending') {
        try {
          const locked = await lockTrade(trade.id, sessionUser.token);
          lockRetryRef.current = null;
          setActiveTrade((prev) => (prev ? { ...prev, ...locked } : prev));
          if (locked.lock_tx_hash) setLockTxHash(locked.lock_tx_hash);
        } catch (lockErr) {
          // La operacion ya existe y quedo `pending`. No se descarta: se avisa
          // y se deja reintentar, porque descartarla dejaria una operacion
          // huerfana en el servidor y al agente esperando.
          lockRetryRef.current = { tradeId: trade.id, counterpartyId, flow: tradeFlow };
          setTradeError(mapApiError(lockErr));
          return false;
        }
      } else if (trade.lock_tx_hash) {
        setLockTxHash(trade.lock_tx_hash);
      }
      return true;
    } catch (e) {
      const mapped = mapApiError(e);
      setTradeError(mapped);
      if (IS_DEMO_MODE) {
        setActiveTrade({
          id: `demo-${Date.now()}`,
          status: 'locked',
          secret_hash: 'demo',
          amount_mxn: activeAmount,
          lock_tx_hash: 'mock_lock_hash',
        });
        setLockTxHash('mock_lock_hash');
        return true;
      }
      return false;
    } finally {
      setTradeLoading(false);
    }
  };

  const retryTradeFlow = async (): Promise<boolean> => {
    if (!pendingSellerId) return false;
    return runTradeFlow(pendingSellerId, pendingFlow);
  };

  const checkBackupGate = async (execute: () => Promise<boolean>): Promise<boolean> => {
    // En la web no hay llave que respaldar: solo importa que la billetera siga igual.
    if (IS_EXTERNAL_SIGNER) {
      try {
        await (await import('./lib/signer/externalSigner')).assertWalletReady();
      } catch (e) {
        setTradeError({ ...mapApiError(e), message: e instanceof Error ? e.message : mapApiError(e).message });
        return false;
      }
      return execute();
    }
    const confirmed = await isBackupConfirmed();
    if (confirmed) {
      return execute();
    }
    return new Promise<boolean>((resolve) => {
      setPendingTradeContext({ resolve, execute });
      setShowBackupPrompt(true);
    });
  };

  // Cashout ("convert crypto to cash"): the caller gives up crypto. CASH-1 —
  // we now send the product flow and let the backend derive the escrow roles
  // (caller as seller, since only sellers can lock funds and reveal the HTLC
  // secret) and the Red MicoPay provider from it.
  const handleOfferSelected = async (offerId: string) => checkBackupGate(() => runTradeFlow(offerId, 'cashout'));

  // Deposit ("buy crypto with cash"): the caller receives crypto and the
  // merchant locks funds as escrow seller. Same behaviour as before.
  const handleDepositOfferSelected = async (offerId: string) => checkBackupGate(() => runTradeFlow(offerId, 'deposit'));

  useEffect(() => {
    if (!showBackupPrompt) return;
    // Mostrar la llave siempre pide confirmacion, sin ventana de gracia:
    // es el secreto de mayor valor del sistema.
    revealSecretKey()
      .then(setBackupSecret)
      .catch((err) => {
        // El modal solo se monta con la llave ya en mano, asi que si revelarla
        // falla no hay nada que enseñar. Cerrar la compuerta y devolver "no"
        // es la unica salida: dejarla abierta deja la operacion colgada
        // esperando una promesa que ya no va a resolver nadie.
        console.error(err);
        handleCloseBackup();
      });
  }, [showBackupPrompt]);

  // T-12/T-13 dejo esta compuerta atras. Los otros dos flujos de respaldo
  // pasaron a SecretKeyBackupModal —FLAG_SECURE y sin portapapeles— pero este,
  // que es el que bloquea la PRIMERA operacion con fondos, seguia escribiendo
  // la llave secreta en el portapapeles global: en Android 13+ el sistema la
  // previsualiza en pantalla y se queda en el buffer hasta que se copie otra
  // cosa, y desde un WebView no se puede marcar con EXTRA_IS_SENSITIVE.
  //
  // Y peor que el portapapeles: copiar marcaba la cuenta como respaldada y
  // "Continuar" ejecutaba la operacion de todas formas. La compuerta no
  // guardaba nada. Ahora solo se pasa transcribiendo los ultimos 4 caracteres,
  // que es la misma prueba que exige el alta.

  // SecretKeyBackupModal llama a onConfirmed y JUSTO DESPUES a onClose — un
  // solo camino de cierre para los tres flujos que lo usan. Sin esta marca,
  // confirmar dispararia tambien la rama de cancelar: la operacion se
  // ejecutaria y a la vez la compuerta se resolveria como "no".
  const backupConfirmedRef = useRef(false);

  const handleBackupConfirmed = () => {
    backupConfirmedRef.current = true;
    void setBackupConfirmed();
    setShowBackupPrompt(false);
    if (pendingTradeContext) {
      pendingTradeContext.execute().then(pendingTradeContext.resolve);
      setPendingTradeContext(null);
    }
  };

  const handleCloseBackup = () => {
    if (backupConfirmedRef.current) {
      backupConfirmedRef.current = false;
      return;
    }
    setShowBackupPrompt(false);
    if (pendingTradeContext) {
      pendingTradeContext.resolve(false);
      setPendingTradeContext(null);
    }
  };

  const ctx: AppCtx = {
    sessionUser,
    providerStatus,
    refreshProviderStatus,
    availability,
    onboardingSeen,
    markOnboardingSeen: () => {
      setOnboardingSeen(true);
      void writeJSON(ONBOARDING_SEEN_KEY, { seen: true });
    },
    activeTrade,
    lockTxHash,
    releaseTxHash,
    activeAmount,
    activeAssetKey,
    tradeLoading,
    tradeError,
    flow,
    devicePublicKey,
    setActiveAmount,
    setActiveAssetKey,
    setFlow,
    setReleaseTxHash,
    handleOfferSelected,
    handleDepositOfferSelected,
    clearTradeError,
    retryTradeFlow,
    allowNewTrade,
    handleAccountDeleted,
    resetTradeFlow,
    envName,
    backendUrl,
    isDemoMode,
    isMockStellar,
    backendConnected,
    backendHealth,
  };

  if (startupError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FFF8F8] px-6 py-12">
        <div className="max-w-md w-full bg-papel rounded-sm p-8 border border-red-100 animate-fade-in font-['Manrope']">
          <div className="flex items-center justify-center w-16 h-16 rounded-sm bg-red-50 text-red-500 mx-auto mb-6">
            <span className="material-symbols-outlined text-4xl">warning</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 text-center mb-2">
            {startupError.title}
          </h1>
          <p className="text-gray-600 text-center mb-6 text-xs leading-relaxed">
            {startupError.message}
          </p>
          {startupError.details && (
            <div className="bg-gray-50 rounded-sm p-4 border border-gray-100 mb-6">
              <p className="text-[10px] text-gray-500 font-mono break-words leading-normal">
                {startupError.details}
              </p>
            </div>
          )}
          <button
            onClick={() => window.location.reload()}
            className="w-full py-3 px-4 bg-gray-900 hover:bg-gray-800 text-papel rounded-sm font-semibold text-xs transition-all duration-200 flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base">refresh</span>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  if (!authReady) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-fondo">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
    );
  }

  return (
      <ErrorBoundary>
        <AppContext.Provider value={ctx}>
          <HashRouter>
            <AppFrame>
              {IS_EXTERNAL_SIGNER && sessionUser && <WebSessionGuard onExpired={handleAccountDeleted} />}
              <ConnectionBannerHost />
              {/* Se oculta solo cuando hay conexión y no hay nada pendiente. */}
              <OfflineQueueStatus token={sessionUser?.token ?? null} />
              <PushNotificationsBridge />
              {/* WP8: en PC no hay push; los avisos salen de aqui. */}
              {IS_EXTERNAL_SIGNER && sessionUser?.token && sessionUser.id && (
                <WebNotifications token={sessionUser.token} userId={sessionUser.id} />
              )}
              <Routes>
                <Route path="/login" element={IS_EXTERNAL_SIGNER ? <WalletLogin onLoginSuccess={handleLoginSuccess} /> : <Login onLoginSuccess={handleLoginSuccess} />} />
                <Route path="/register" element={IS_EXTERNAL_SIGNER ? <Navigate to="/login" replace /> : <Register onLoginSuccess={handleLoginSuccess} />} />
                <Route path="/" element={<ProtectedRoute><HomeRoute /></ProtectedRoute>} />
                <Route path="/history" element={<ProtectedRoute><HistoryRoute /></ProtectedRoute>} />
                <Route path="/trade/:id" element={<ProtectedRoute><TradeDetailRoute /></ProtectedRoute>} />
                <Route path="/merchant-settings" element={<ProtectedRoute><MerchantSettingsRoute /></ProtectedRoute>} />
                <Route path="/inbox" element={<ProtectedRoute><InboxRoute /></ProtectedRoute>} />
                <Route path="/cashout" element={<ProtectedRoute><CashoutRoute /></ProtectedRoute>} />
                <Route path="/pay" element={<ProtectedRoute><PayHubRoute /></ProtectedRoute>} />
                <Route path="/pay/send" element={<ProtectedRoute><SendPaymentRoute /></ProtectedRoute>} />
                <Route path="/pay/receive" element={<ProtectedRoute><ReceivePaymentRoute /></ProtectedRoute>} />
                <Route path="/deposit" element={<ProtectedRoute><DepositRoute /></ProtectedRoute>} />
                <Route path="/map" element={<ProtectedRoute><MapRoute /></ProtectedRoute>} />
                <Route path="/confirm" element={<ProtectedRoute><ConfirmRoute /></ProtectedRoute>} />
                <Route path="/map-deposit" element={<ProtectedRoute><MapDepositRoute /></ProtectedRoute>} />
                <Route path="/chat" element={<ProtectedRoute><ChatRoute /></ProtectedRoute>} />
                <Route path="/chat/:tradeId" element={<ProtectedRoute><ChatRoute /></ProtectedRoute>} />
                <Route path="/chat-deposit" element={<ProtectedRoute><ChatDepositRoute /></ProtectedRoute>} />
                <Route path="/qr-reveal" element={<ProtectedRoute><QRRevealRoute /></ProtectedRoute>} />
                <Route path="/qr-deposit" element={<ProtectedRoute><QRDepositRoute /></ProtectedRoute>} />
                <Route path="/qr-deposit/:tradeId" element={<ProtectedRoute><QRDepositRoute /></ProtectedRoute>} />
                <Route path="/success" element={<ProtectedRoute><SuccessRoute /></ProtectedRoute>} />
                <Route path="/explore" element={<ProtectedRoute><ExploreRoute /></ProtectedRoute>} />
                <Route path="/cetes" element={<ProtectedRoute><CetesRoute /></ProtectedRoute>} />
                <Route path="/retirar-banco" element={<ProtectedRoute><BankWithdrawRoute /></ProtectedRoute>} />
                {/* KYC-1: rutas explicitas por proposito. `/kyc` sigue
                    siendo el del anchor para no romper enlaces existentes. */}
                <Route path="/kyc" element={<ProtectedRoute><KYCRoute /></ProtectedRoute>} />
                <Route path="/kyc/etherfuse" element={<ProtectedRoute><KYCRoute /></ProtectedRoute>} />
                <Route path="/kyc/didit" element={<ProtectedRoute><DiditKYCRoute /></ProtectedRoute>} />
                <Route path="/kyc-approved" element={<ProtectedRoute><KYCApprovedNextRoute /></ProtectedRoute>} />

                <Route path="/blend" element={<ProtectedRoute><BlendRoute /></ProtectedRoute>} />
                <Route path="/welcome" element={<ProtectedRoute><WelcomeRoute /></ProtectedRoute>} />
                <Route path="/join-network" element={<ProtectedRoute><ProviderOnboardingRoute /></ProtectedRoute>} />
                <Route path="/profile" element={<ProtectedRoute><ProfileRoute /></ProtectedRoute>} />
                {!IS_EXTERNAL_SIGNER && <Route path="/conexiones-web" element={<ProtectedRoute><WalletConnections /></ProtectedRoute>} />}
                <Route path="/privacy" element={<ProtectedRoute><PrivacyRoute /></ProtectedRoute>} />
                <Route path="/terms" element={<ProtectedRoute><TermsRoute /></ProtectedRoute>} />
                {!IS_EXTERNAL_SIGNER && <Route path="/sign-request" element={<ProtectedRoute><SignatureApprovalRoute /></ProtectedRoute>} />}
                {!IS_EXTERNAL_SIGNER && <Route path="/sign-request/:id" element={<ProtectedRoute><SignatureApprovalRoute /></ProtectedRoute>} />}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <BottomNavAdapter />
              <WalletRequestSheet />

              {showBackupPrompt && backupSecret && (
                <SecretKeyBackupModal
                  secretKey={backupSecret}
                  requireConfirmation
                  reason="Antes de tu primera operación con fondos tienes que respaldar tu llave secreta. Sin ella, si pierdes el teléfono pierdes el dinero."
                  onConfirmed={handleBackupConfirmed}
                  onClose={handleCloseBackup}
                />
              )}
            </AppFrame>
          </HashRouter>
        </AppContext.Provider>
      </ErrorBoundary>
  );
}

export default App;
