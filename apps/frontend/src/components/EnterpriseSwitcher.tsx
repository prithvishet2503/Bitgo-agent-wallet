import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { Enterprise } from '@bitgo-agent-wallet/sdk';
import { client } from '../api/client';
import { useAuth } from '../context/AuthContext';

/** An Organization can contain more than one Enterprise; this lets a user with
 * access to several switch which one the console (and every API call) acts on,
 * and admins spin up a new one without leaving the console. */
export function EnterpriseSwitcher(): ReactElement {
  const { identity, currentEnterpriseId, switchEnterprise } = useAuth();
  const [enterprises, setEnterprises] = useState<Enterprise[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    client.listEnterprises().then(setEnterprises);
  }, [currentEnterpriseId]);

  function handleSwitch(id: string): void {
    switchEnterprise(id);
    window.location.reload(); // simplest way to re-fetch every enterprise-scoped page
  }

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    const enterprise = await client.createEnterprise({ name: newName });
    setNewName('');
    setShowCreate(false);
    handleSwitch(enterprise.id);
  }

  if (!identity) return <></>;

  return (
    <div className="enterprise-switcher">
      <label>Enterprise</label>
      <select value={currentEnterpriseId ?? ''} onChange={(e) => handleSwitch(e.target.value)}>
        {enterprises.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {identity.role === 'admin' &&
        (showCreate ? (
          <form className="new-enterprise-form" onSubmit={handleCreate}>
            <input
              value={newName}
              onChange={(ev) => setNewName(ev.target.value)}
              placeholder="New enterprise name"
              autoFocus
              required
            />
            <button type="submit">Create</button>
          </form>
        ) : (
          <button type="button" className="link-btn" onClick={() => setShowCreate(true)}>
            + New enterprise
          </button>
        ))}
    </div>
  );
}
