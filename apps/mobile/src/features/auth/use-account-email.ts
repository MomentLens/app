import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';

// The signed-in account's email, which GET /profiles/me does not return, read from the session
// Supabase Auth keeps on the phone. Null until it is read, or when there is none.
export function useAccountEmail(): string | null {
  const userId = useAuthStore((state) => state.userId);
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (current) setEmail(data.session?.user.email ?? null);
    });
    return () => {
      current = false;
    };
  }, [userId]);
  return email;
}
