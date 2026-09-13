import { MerchantConsole } from "@/components/MerchantConsole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The merchant's console.
 *
 * Nothing is decided on the server here -- the client fetches its own state, the
 * same way Mission Control does, so the page is honest about watching a running
 * system rather than rendering a snapshot.
 */
export default function Page() {
  return <MerchantConsole />;
}
