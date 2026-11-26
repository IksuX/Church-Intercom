// Interkom – konfiguracja aplikacji. Aplikacja startuje od ekranu wyboru serwera (www/index.html):
// serwery z sieci lokalnej (wyszukiwane automatycznie), ostatnio używane i wpisane ręcznie.
// IK_SERVER_URL (opcjonalnie) – serwer podpowiadany na liście („Serwer domyślny”; domyślnie brak), np.:  IK_SERVER_URL=https://interkom.parafia.pl npx cap sync
import type { CapacitorConfig } from '@capacitor/cli';

const defaultServer = process.env.IK_SERVER_URL || ''; // bez podpowiedzi – użytkownik wybiera serwer z sieci albo wpisuje adres

const config: CapacitorConfig = {
  appId: process.env.IK_APP_ID || 'pl.churchinterkom.app', // Bundle ID w App Store Connect (nie da się go później zmienić)
  appName: 'Interkom',
  webDir: 'www',
  server: {
    errorPath: 'error.html', // gdy serwer nie odpowiada – strona z „Spróbuj ponownie” / „Wybierz inny serwer”
    // logowanie przez Planning Center musi zostać w aplikacji (wybrany serwer dopuszcza wtyczka ik-audio)
    allowNavigation: ['planningcenteronline.com', '*.planningcenteronline.com'],
  },
  plugins: { IkAudio: { defaultServer } },
  ios: { contentInset: 'never', limitsNavigationsToAppBoundDomains: false },
  android: { allowMixedContent: false },
};

export default config;
