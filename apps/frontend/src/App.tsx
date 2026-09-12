import type { ReactElement } from 'react';
import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { SubWallets } from './pages/SubWallets';
import { SubWalletDetail } from './pages/SubWalletDetail';
import { Approvals } from './pages/Approvals';
import { Quarantine } from './pages/Quarantine';
import { AuditLog } from './pages/AuditLog';

function Gate(): ReactElement {
  const { identity, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (!identity) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/sub-wallets" replace />} />
        <Route path="/sub-wallets" element={<SubWallets />} />
        <Route path="/sub-wallets/:id" element={<SubWalletDetail />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/quarantine" element={<Quarantine />} />
        <Route path="/audit-log" element={<AuditLog />} />
        <Route path="*" element={<Navigate to="/sub-wallets" replace />} />
      </Route>
    </Routes>
  );
}

export default function App(): ReactElement {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
