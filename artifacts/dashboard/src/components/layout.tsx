import { Link, useLocation } from "wouter";
import { Activity, LayoutDashboard, List, Settings } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen w-full bg-background text-foreground dark overflow-hidden">
      {/* Sidebar */}
      <aside className="w-16 md:w-64 border-r border-border bg-sidebar flex flex-col items-center md:items-stretch">
        <div className="h-16 flex items-center justify-center md:justify-start md:px-6 border-b border-border">
          <Activity className="w-6 h-6 text-primary" />
          <span className="hidden md:block ml-3 font-bold tracking-tight">UNIFIED<span className="text-primary">v1</span></span>
        </div>
        
        <nav className="flex-1 py-6 flex flex-col gap-2 px-2 md:px-4">
          <Link 
            href="/" 
            className={`flex items-center gap-3 px-2 md:px-3 py-2.5 rounded-md transition-colors ${location === "/" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
          >
            <LayoutDashboard className="w-5 h-5 shrink-0" />
            <span className="hidden md:block text-sm font-medium">Dashboard</span>
          </Link>
          <Link 
            href="/signals" 
            className={`flex items-center gap-3 px-2 md:px-3 py-2.5 rounded-md transition-colors ${location.startsWith("/signals") || location.startsWith("/signal/") ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
          >
            <List className="w-5 h-5 shrink-0" />
            <span className="hidden md:block text-sm font-medium">Signals</span>
          </Link>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <div className="absolute inset-0 pointer-events-none opacity-20 mix-blend-overlay bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPgo8cmVjdCB3aWR0aD0iNCIgaGVpZ2h0PSI0IiBmaWxsPSIjZmZmIiBmaWxsLW9wYWNpdHk9IjAuMDUiLz4KPHJlY3QgeD0iMCIgeT0iMCIgd2lkdGg9IjIiIGhlaWdodD0iMiIgZmlsbD0iIzAwMCIgZmlsbC1vcGFjaXR5PSIwLjEiLz4KPC9zdmc+')]"></div>
        <header className="h-16 border-b border-border flex items-center px-6 shrink-0 bg-background/95 backdrop-blur z-10">
          <div className="flex-1"></div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              LIVE
            </span>
            <span className="font-mono">WS_CONN_OK</span>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-4 md:p-6 z-10">
          {children}
        </div>
      </main>
    </div>
  );
}
