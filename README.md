# Hydranten-Erfasser

PWA (Web-App für Android, iOS & Desktop) zum direkten Eintragen von Wasserentnahme­stellen
und Rettungspunkten in **OpenStreetMap**. Läuft komplett im Browser, ohne eigenen Server.
Schreibt per OAuth2 (PKCE) direkt in OSM.

## Erfassbare Typen (Tags wie in der Waldbrand-Karte)
| Button | OSM-Tags |
|---|---|
| Hydrant Unterflur | `emergency=fire_hydrant` + `fire_hydrant:type=underground` |
| Hydrant Überflur | `emergency=fire_hydrant` + `fire_hydrant:type=pillar` |
| Wandhydrant | `emergency=fire_hydrant` + `fire_hydrant:type=wall` |
| Löschbrunnen | `emergency=fire_hydrant` + `fire_hydrant:type=pipe` |
| Wasserbehälter | `emergency=water_tank` (+ `water_tank:volume`) |
| Löschteich | `emergency=fire_water_pond` |
| Saugstelle | `emergency=suction_point` |
| Rettungspunkt | `highway=emergency_access_point` (+ `ref`) |

---

## Einmalige Einrichtung: OSM-OAuth2-App registrieren

1. Bei <https://www.openstreetmap.org> einloggen.
2. Auf <https://www.openstreetmap.org/oauth2/applications> → **„Neue Anwendung registrieren"**.
3. **Name:** z.B. `Hydranten-Erfasser`
4. **Redirect URI** = exakt die Adresse, unter der die App läuft:
   - Lokaler Test: `http://127.0.0.1:8765/`
   - GitHub Pages: `https://DEINNAME.github.io/hydranten-erfasser/`
5. **Confidential application?** → **NICHT** ankreuzen (öffentlicher Client).
6. Berechtigungen ankreuzen: **`read_prefs`** und **`write_api`**.
7. Registrieren → die angezeigte **Client ID** kopieren.
8. App öffnen → beim ersten Start die Client ID einfügen → „Speichern & starten".

> Die Client ID wird nur lokal im Browser gespeichert. Es gibt **kein** Secret (PKCE).

---

## Lokal testen (Windows)

```powershell
cd "$env:USERPROFILE\Desktop\Hydranten-Erfasser"
python -m http.server 8765 --bind 127.0.0.1
```
Dann im Browser: <http://127.0.0.1:8765/>
(Redirect URI in der OSM-App muss `http://127.0.0.1:8765/` sein.)

---

## Auf dem Handy nutzen (Feldeinsatz) → HTTPS-Hosting

OAuth + GPS brauchen auf dem Handy **HTTPS**. Einfachster kostenloser Weg: **GitHub Pages**.

1. Neues GitHub-Repo `hydranten-erfasser` anlegen, alle Dateien hochladen.
2. Settings → Pages → Branch `main` / Root → speichern.
3. Nach 1–2 Min. erreichbar unter `https://DEINNAME.github.io/hydranten-erfasser/`.
4. Diese URL als Redirect URI in der OSM-App eintragen (Schritt 4 oben).
5. Auf dem Handy öffnen → Browser-Menü → **„Zum Startbildschirm hinzufügen"**.
   Danach startet sie wie eine echte App (Vollbild, Icon).

---

## Bedienung
- **📍** zentriert auf den eigenen GPS-Standort.
- Karte so schieben, dass das **Fadenkreuz** auf der Stelle liegt.
- **+ Hier erfassen** → Typ wählen, optionale Felder, **In OSM speichern**.
- Mehrere Punkte landen im selben Änderungssatz; **✓** schließt ihn ab.
- Jeder gespeicherte Punkt zeigt einen Link zum neuen OSM-Knoten.

Neue Einträge erscheinen nach kurzer Zeit (Overpass-Aktualisierung) automatisch
in den 4A0-Ortsteilkarten beim nächsten Lauf von `waldbrand_ortsteile.py`.
