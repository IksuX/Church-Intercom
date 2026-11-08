# Interkom – aplikacja na iPhone i Android (1.4.1)

Aplikacja to „opakowanie” zwykłej strony interkomu (ten sam wygląd, logowanie, czat, powiadomienia),
ale **dźwięk obsługuje natywnie** (LiveKit), dzięki czemu:

- słychać i można mówić **przy zablokowanym ekranie / w kieszeni**,
- działają **przyciski sprzętowe**: przycisk na słuchawkach, piloty/przyciski PTT Bluetooth, przyciski głośności,
- powiadomienia (wezwania, wzmianki) przychodzą przez połączenie aplikacji – bez Web Push.

Strona nadal działa w przeglądarce jak dotąd – aplikacja jest dodatkiem. Wymaga serwera **0.32.0+** (wyszukiwanie w sieci: **0.33.0+**).

## Wybór serwera

Aplikacja startuje od ekranu **wyboru serwera**:
- **W tej sieci** – serwery interkomu znalezione automatycznie w Wi-Fi (serwer ogłasza się przez mDNS/Bonjour;
  instalator 0.33.0+ instaluje do tego `avahi-daemon`). Serwer w internecie (VPS) się tu nie pojawia.
- **Ostatnio używane** i **Serwer domyślny** (z `IK_SERVER_URL` przy budowaniu).
- **Wpisz adres** – domena albo adres IP, np. `192.168.1.10`.

Wybrany serwer jest zapamiętywany – kolejne uruchomienia otwierają go od razu. Zmiana: przycisk
**🔁 Zmień serwer** na ekranie logowania i w ⚙️. Gdy serwer nie odpowiada, pojawia się ekran
„Brak połączenia” z przyciskami „Spróbuj ponownie” / „Wybierz inny serwer”.

iPhone przy pierwszym wyszukiwaniu zapyta o dostęp do **sieci lokalnej** – trzeba zezwolić
(później: Ustawienia → Prywatność i ochrona → Sieć lokalna → Interkom).

## Wymagania

- Mac z **Xcode 16+** (iOS) i **Android Studio** (Ladybug lub nowsze, JDK 21) – Android można budować też na Windows/Linux,
- **Node 22+**,
- iPhone: konto Apple Developer (99 USD/rok) do TestFlight / instalacji ad-hoc; darmowe konto Apple ID pozwala
  zainstalować aplikację na własnym iPhonie, ale wygasa po 7 dniach,
- Android: nic – plik APK instaluje się bezpośrednio.

## Budowanie

```bash
cd mobile
npm install
export IK_SERVER_URL=https://57-128-249-85.sslip.io   # opcjonalnie – „Serwer domyślny” na liście
export IK_APP_ID=pl.cme.interkom                      # opcjonalnie – identyfikator aplikacji
npx cap add ios
npx cap add android
npm run sync
```

`npm run sync` (oraz `npm run ios` / `npm run android`) uruchamia też skrypty `scripts/ios-setup.sh`
i `scripts/android-setup.sh`, które uzupełniają Info.plist i MainActivity – uruchamiaj je po każdym `cap add`.
Zmiany w samej stronie (serwer) **nie wymagają** przebudowy aplikacji – aplikacja wczytuje stronę z serwera.

### iPhone

1. `npm run ios` – otworzy się Xcode.
2. Projekt **App** → zakładka *Signing & Capabilities* → wybierz swój *Team*.
3. Sprawdź, że w *Background Modes* jest zaznaczone **Audio, AirPlay and Picture in Picture**
   (skrypt `scripts/ios-setup.sh` dopisuje to do Info.plist).
4. Podłącz iPhone’a → ▶ Run. Do dystrybucji: *Product → Archive → Distribute → TestFlight*
   (TestFlight nie wymaga publikacji w App Store; zapraszasz zespół mailem).

### Android

1. `npm run android` – otworzy się Android Studio (poczekaj na Gradle sync).
2. ▶ Run na podłączonym telefonie albo *Build → Generate Signed App Bundle / APK → APK*.
3. Plik APK (*Build → Build App Bundle(s) / APK(s) → Build APK(s)*, wynik: `android/app/build/outputs/apk/debug/app-debug.apk`) wgraj w panelu interkomu: **Ogólne → Aplikacja na telefon → Wgraj plik APK**. Na ekranie logowania pojawi się przycisk „Pobierz na Androida (APK)”. Instalacja: zezwól przeglądarce na „instalowanie nieznanych aplikacji”.
4. Po instalacji: Ustawienia → Aplikacje → Interkom → Bateria → **Bez ograniczeń** (inaczej niektóre telefony
   – Xiaomi, Huawei, Samsung – mogą zamykać aplikację w tle).

## Przyciski

Ustawienia: w aplikacji **Ustawienia → Dźwięk → Przyciski** (widoczne tylko w aplikacji).

| | Android | iPhone |
|---|---|---|
| Przycisk na słuchawkach / Bluetooth (play/pauza) | przytrzymaj lub naciśnij–naciśnij; także przy zablokowanym ekranie | naciśnij – mów, naciśnij – koniec (iOS nie przekazuje „puszczenia”); także przy zablokowanym ekranie |
| AirPods (ściśnięcie nóżki) | zależnie od telefonu | nie działa – w trakcie „rozmowy” iOS obsługuje gest sam (wymagałoby CallKit) |
| Przycisk PTT Bluetooth (pilot) | „Naucz przycisk PTT” – dowolny przycisk; przytrzymanie działa | działa, jeśli pilot wysyła play/pauza (większość pilotów) |
| Przyciski głośności | gdy ekran włączony | gdy aplikacja na ekranie; zmienia też głośność |

Krótkie naciśnięcie (< 0,35 s) w trybie „przytrzymaj” na Androidzie działa jak włącz/wyłącz.

## Jak to działa (dla ciekawych)

- `plugins/ik-audio` – natywna wtyczka (Swift / Kotlin) z LiveKit SDK.
- Strona w aplikacji wykrywa wtyczkę i oddaje jej dźwięk; mikrofon jest stale gotowy, ale wyciszony do naciśnięcia.
- Serwer co chwilę wysyła aplikacji listę osób, które ma słyszeć (wg kanałów), więc wszystko działa nawet gdy
  strona w tle „śpi”. Aplikacja zgłasza się serwerowi co 20 s (`/api/native/beat`).
- Mówienie przyciskiem sprzętowym idzie bezpośrednio do serwera (`/api/native/ptt`); nagranie do transkrypcji
  aplikacja wysyła sama.
- Android: usługa pierwszoplanowa (stałe powiadomienie „Interkom aktywny”) + MediaSession.
- iPhone: tryb audio w tle + MPRemoteCommandCenter.

## Ograniczenia

- iPhone: przycisk słuchawek działa wyłącznie jako przełącznik (ograniczenie systemu). Prawdziwe „przytrzymaj i mów”
  na iOS daje dopiero framework Apple PushToTalk – możliwy w kolejnej wersji.
- Słuchanie dźwięku transmisji w aplikacji idzie przez LiveKit (nie tryb „ultra”/lokalny z przeglądarki).
- Gdy telefon całkowicie zamknie aplikację (przesunięcie w górę na liście aplikacji), połączenie się kończy.
