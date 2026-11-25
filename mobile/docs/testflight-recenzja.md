# Interkom 1.6.1 – teksty do App Store Connect (TestFlight)

Gotowe teksty do wklejenia w App Store Connect → aplikacja **Interkom** → **TestFlight**.
Po polsku i po angielsku (recenzenci Apple czytają po angielsku – wklej wersję angielską, polską trzymaj dla zespołu).

> **Bez haseł i PIN-ów w tym pliku.** PIN konta demo wpisujesz tylko w App Store Connect, w polu *Sign-in information*.
> Repozytorium jest publiczne.

Do uzupełnienia przed wysłaniem:

- `[E-MAIL KONTAKTOWY]` – adres do kontaktu w sprawie aplikacji i danych (ten sam co w panelu → Ogólne → Prywatność),
- PIN konta demo – panel serwera VPS → Ogólne → Konto demo (włącz, ustaw PIN, wybierz kanał), potem wpisz go w App Store Connect.

| Pole | Wartość |
|---|---|
| Bundle ID | `pl.churchinterkom.app` |
| Wersja / kompilacja | 1.6.1 / numer z `mobile/build-number` |
| Serwer demo | `https://malinkainterkom.duckdns.org` |
| Polityka prywatności (Privacy Policy URL) | `https://malinkainterkom.duckdns.org/prywatnosc` |
| Kontakt (Feedback Email) | `[E-MAIL KONTAKTOWY]` |
| Sign-in required | Tak – nazwa użytkownika: `Apple Review` (dowolna), hasło: PIN konta demo |

---

## Beta App Description

**EN**

Interkom is a self-hosted intercom for church service teams – sound, cameras, live stream, worship and hospitality crews. Team members talk to each other with push-to-talk voice channels (also with the screen locked and via headset buttons, like a walkie-talkie), chat in text channels, see live transcripts of what was said and can have messages read aloud. The app connects only to the intercom server chosen by the user (on the church Wi-Fi or on the internet). The church runs that server itself. Speech recognition runs on the church's own server – no cloud services, no analytics, no ads.

**PL**

Interkom to interkom dla ekip obsługujących nabożeństwa: dźwięk, kamery, transmisja, uwielbienie, powitanie. Zespół rozmawia na kanałach głosowych „naciśnij i mów” (także przy zablokowanym ekranie i przyciskiem na słuchawkach, jak krótkofalówka), pisze na czacie, widzi transkrypcję wypowiedzi i może słuchać wiadomości czytanych na głos. Aplikacja łączy się tylko z serwerem interkomu wybranym przez użytkownika (w Wi-Fi kościoła albo w internecie), który kościół utrzymuje sam. Rozpoznawanie mowy działa na serwerze kościoła – bez usług w chmurze, analityki i reklam.

## What to Test (1.6.1)

**EN**

- First sign-in: choose the server, sign in with the PIN, read the privacy notice and tap “Rozumiem” (I understand).
- Push-to-talk: hold “Mów” (Talk). A red bar “Mówisz – kanał …” (You are talking – channel …) stays at the top of every screen while the microphone is open. On channels with transcription it also shows “· transkrypcja”.
- Talking and listening with the screen locked, headset button as push-to-talk (press to talk, press again to stop). The mic turns itself off after 8 s of silence or 60 s; a short tone every 10 s reminds you it is open.
- Lock Screen card (Live Activity): tap it, unlock, then hold the big “Przytrzymaj i mów” (Hold and talk) button. Releasing it, locking the phone or leaving the app stops transmitting.
- Privacy policy link: login screen, ⚙️ Settings → Konto (Account) and the server picker.
- Server search on local Wi-Fi and the local network permission prompt.

**PL**

- Pierwsze logowanie: wybór serwera, PIN, informacja o prywatności i „Rozumiem”.
- Mówienie: przytrzymaj „Mów”. Czerwony pasek „Mówisz – kanał …” jest u góry każdego ekranu, dopóki mikrofon jest otwarty, a przy kanale z transkrypcją widać też „· transkrypcja”.
- Mówienie i słuchanie przy zablokowanym ekranie, przycisk na słuchawkach (naciśnij – mów, naciśnij – koniec). Mikrofon wyłącza się sam po 8 s ciszy albo po 60 s, a co 10 s słychać krótki sygnał.
- Karta na ekranie blokady: stuknij, odblokuj telefon i przytrzymaj „Przytrzymaj i mów”. Puszczenie, zablokowanie telefonu lub wyjście z aplikacji kończy mówienie.
- Link do polityki prywatności: ekran logowania, ⚙️ Ustawienia → Konto, ekran wyboru serwera.
- Wyszukiwanie serwera w sieci Wi-Fi i pytanie o zgodę na sieć lokalną.

## Review Notes

**EN**

How to sign in

1. On first launch the app shows the server picker. Tap **“Serwer domyślny (internet)”** – `malinkainterkom.duckdns.org`. You can also type that address under “Wpisz adres” (Enter address). The “W tej sieci” (On this network) section searches the church Wi-Fi only, so it will be empty for you – that is expected.
2. On the login screen enter the **PIN from the “Sign-in information” field** (“PIN ekipy”) and any name (e.g. “Apple Review”), then tap **“Dołącz”** (Join). The demo account does not need Planning Center. “Zaloguj przez Planning Center” is an optional login for church members.
3. A privacy notice appears on first sign-in – tap **“Rozumiem”** (I understand).
4. The demo account (“Recenzent Apple”) can talk and sees two channels: **Ogólny** (General) and a team channel with sample messages. Hold **“Mów”** to talk. The red bar at the top shows that the microphone is open.

Why we need these permissions

- **Microphone** – only to talk to the team while the user holds “Mów” (or presses the headset / Bluetooth PTT button). A red “Mówisz” (You are talking) bar is shown on every screen while the mic is open, and the iOS microphone indicator is visible.
- **Background audio (UIBackgroundModes: audio)** – the app works like a walkie-talkie: crew members keep the phone locked in a pocket during the service, keep hearing the team and can talk with the headset button.
- **Local network** – only to find the intercom server on the church Wi-Fi (Bonjour `_interkom._tcp`). The server runs on a computer in the church.
- **Bluetooth** – for Bluetooth headsets and Bluetooth push-to-talk remotes.
- **Camera** – not used. The app never asks for camera access. The purpose string is there only because the voice library (LiveKit / WebRTC) contains video code.

Speech-to-text runs on the church's own server (open-source Whisper on the same machine as the intercom). Audio and transcripts are never sent to any cloud service. The server deletes messages and transcripts automatically after the period set by the church (default 30 days). The app has no analytics, ads or tracking.

All features (no hidden features)

- Voice channels with push-to-talk, text chat, quick status buttons (“OK”, “Gotowe”/Ready, “Czekam”/Waiting, “PILNE”/Urgent), private messages, calling a person, @mentions.
- Lock Screen card (Live Activity) with the current channel, who is talking and whether the mic is open. Tapping it opens a hold-to-talk screen. The mic never opens from the card itself.
- Live transcripts of speech in the chat and reading messages aloud (text-to-speech on the device).
- Service plan from Planning Center, current item and timer (if the church connects Planning Center).
- Live-stream audio monitoring (the church's sound desk mix) with a personal volume mixer.
- **Reżyseria (Director)** – control of a Blackmagic ATEM video switcher in the church: camera preview/program, auto-pilot and voice commands such as “Przygotuj 2” (Prepare camera 2). The demo account cannot see it: it needs the “Reżyser” (Director) role granted by the church administrator, and an ATEM switcher on the church's local network. Without both the menu is hidden.
- The administration panel (`/admin`) runs in a web browser and is not part of the app.

**PL**

Jak się zalogować

1. Przy pierwszym uruchomieniu pokazuje się wybór serwera. Stuknij **„Serwer domyślny (internet)”** – `malinkainterkom.duckdns.org` (albo wpisz ten adres w „Wpisz adres”). Sekcja „W tej sieci” szuka tylko w Wi-Fi kościoła, więc u recenzenta będzie pusta – to normalne.
2. Na ekranie logowania wpisz **PIN z pola „Sign-in information”** (pole „PIN ekipy”) i dowolne imię (np. „Apple Review”), potem stuknij **„Dołącz”**. Konto demo nie wymaga Planning Center. „Zaloguj przez Planning Center” to opcjonalne logowanie dla członków zboru.
3. Przy pierwszym logowaniu pojawia się informacja o prywatności – stuknij **„Rozumiem”**.
4. Konto demo („Recenzent Apple”) może mówić i widzi dwa kanały: **Ogólny** i kanał zespołu z przykładowymi wiadomościami. Przytrzymaj **„Mów”**, żeby mówić. Czerwony pasek u góry pokazuje, że mikrofon jest otwarty.

Po co uprawnienia

- **Mikrofon** – tylko do mówienia do zespołu, gdy użytkownik trzyma „Mów” albo naciśnie przycisk słuchawek lub pilota PTT. Przez cały czas widać czerwony pasek „Mówisz” i systemowy wskaźnik mikrofonu.
- **Dźwięk w tle** – aplikacja działa jak krótkofalówka: w trakcie nabożeństwa telefon jest zablokowany w kieszeni, a osoba dalej słyszy zespół i mówi przyciskiem na słuchawkach.
- **Sieć lokalna** – tylko do wyszukania serwera interkomu w Wi-Fi kościoła (Bonjour `_interkom._tcp`).
- **Bluetooth** – słuchawki i piloty PTT Bluetooth.
- **Aparat** – nieużywany, aplikacja nigdy o niego nie pyta. Opis jest tylko dlatego, że biblioteka do rozmów (LiveKit / WebRTC) zawiera kod wideo.

Transkrypcja działa na serwerze kościoła (Whisper, na tym samym komputerze co interkom). Nagrania i transkrypcje nie trafiają do żadnej usługi w chmurze. Serwer automatycznie usuwa wiadomości i transkrypcje po okresie ustawionym przez kościół (domyślnie 30 dni). Aplikacja nie ma analityki, reklam ani śledzenia.

Wszystkie funkcje (bez ukrytych)

- Kanały głosowe „naciśnij i mów”, czat, szybkie przyciski, wiadomości prywatne, wzywanie osoby, oznaczenia @.
- Karta na ekranie blokady (Live Activity): kanał, kto mówi, czy mikrofon jest włączony. Stuknięcie otwiera ekran „Przytrzymaj i mów”; sama karta nigdy nie włącza mikrofonu.
- Transkrypcja wypowiedzi w czacie i czytanie wiadomości na głos (synteza mowy w telefonie).
- Plan nabożeństwa z Planning Center, bieżący punkt i zegar (gdy kościół podłączy Planning Center).
- Odsłuch dźwięku transmisji (miks z konsolety) z osobistym mikserem głośności.
- **Reżyseria** – sterowanie mikserem wideo Blackmagic ATEM w kościele: podgląd i program kamer, autopilot, komendy głosowe („Przygotuj 2”). Konto demo jej nie widzi: potrzebna jest rola „Reżyser” nadana przez administratora i mikser ATEM w sieci lokalnej kościoła. Bez nich menu jest ukryte.
- Panel administracyjny (`/admin`) działa w przeglądarce i nie jest częścią aplikacji.

## Export Compliance

W Info.plist jest `ITSAppUsesNonExemptEncryption = false`. Aplikacja używa tylko standardowego szyfrowania systemu (HTTPS, WebRTC/DTLS w LiveKit), które jest zwolnione z obowiązku zgłoszenia. App Store Connect nie powinien pytać o szyfrowanie. Jeśli zapyta: *None of the algorithms mentioned above* / *Uses standard encryption only (exempt)*.

## App Privacy (Data Collection) w App Store Connect

Zgodnie z `mobile/resources/PrivacyInfo.xcprivacy`. Każdy typ danych: **Linked to the user**, **Not used for tracking**, cel **App Functionality**:

- Audio Data (głos przy mówieniu, transkrypcja),
- Name (imię),
- Emails or Text Messages (wiadomości na czacie),
- Other User Content (transkrypcje, szybkie przyciski),
- Device ID (identyfikator urządzenia/sesji do powiadomień).

Tracking: **No**.
