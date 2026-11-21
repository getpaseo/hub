import type { ReactNode } from "react";
import { Link, createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { Button } from "../components/ui/button.js";
import "../styles.entry.js";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "referrer", content: "same-origin" },
      { title: "Paseo Hub" },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/favicon.svg",
      },
    ],
  }),
  component: Root,
  notFoundComponent: NotFound,
});

function Root() {
  return (
    <Document>
      <Outlet />
    </Document>
  );
}

function NotFound() {
  return (
    <Document>
      <main className="grid min-h-svh place-items-center px-6 py-16">
        <div className="grid max-w-md gap-4 text-center">
          <p className="text-sm text-muted-foreground">404</p>
          <h1 className="text-xl font-title">Page not found</h1>
          <p className="text-sm text-muted-foreground">
            This address does not match a page in Paseo Hub. Check the address or return home
          </p>
          <div>
            <Button asChild>
              <Link to="/">Return home</Link>
            </Button>
          </div>
        </div>
      </main>
    </Document>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
