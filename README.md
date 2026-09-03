# 🕊️ Paloma + Supabase

Web estática para GitHub Pages que permite enviar un mensaje cifrado con un tiempo de viaje equivalente a una paloma a **80 km/h**.

## Qué hace

- El remitente escribe origen, destino, destinatario, mensaje y clave.
- Se geocodifican origen y destino y se calcula la distancia en línea recta.
- El mensaje se cifra **en el navegador** usando AES-GCM.
- Supabase guarda únicamente el mensaje cifrado.
- Supabase fija la hora de salida y llegada.
- Hay un 8 % de probabilidad de que la entrega se interrumpa.
- Se genera un enlace `?m=<uuid>` que puedes mandar al destinatario.
- Antes de llegar, Supabase **no devuelve el texto cifrado** al navegador.
- Al llegar, el receptor necesita **nombre + clave** para descifrarlo.

## 1. Crear Supabase

1. Crea un proyecto en https://supabase.com/
2. Abre **SQL Editor**.
3. Copia todo `supabase.sql`.
4. Pulsa **Run**.

## 2. Poner las claves

En Supabase abre **Project Settings → API**.

En `app.js` cambia:

```js
const SUPABASE_URL = "https://TU-PROYECTO.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "TU-PUBLISHABLE-KEY";
```

Usa la **Publishable key** (o `anon` key en proyectos antiguos).

**No pongas jamás `service_role` en una web pública.**

La publishable/anon key está pensada para estar en el navegador; la seguridad la controlan RLS, permisos y las funciones SQL.

## 3. Probar en local

Lo ideal es servir la carpeta con un servidor HTTP, no abrir `index.html` como `file://`.

Por ejemplo:

```bash
python3 -m http.server 8080
```

Y abre:

```text
http://localhost:8080
```

## 4. GitHub Pages

Sube estos archivos a tu repo:

- `index.html`
- `app.js`

Después:

1. Repo → **Settings**
2. **Pages**
3. Deploy from a branch
4. Selecciona `main` y `/ (root)`

## Prueba rápida

Madrid → Barcelona tarda varias horas a 80 km/h.

Para probar la pantalla de llegada sin esperar, en `supabase.sql` puedes cambiar temporalmente:

```sql
v_duration := make_interval(
  secs => greatest(5.0, (p_distance_km / 80.0) * 3600.0)
);
```

por:

```sql
v_duration := make_interval(secs => 20);
```

Luego vuelve a ejecutar el `create or replace function public.create_delivery(...)`.

Así cada nueva paloma tarda 20 segundos.

## Seguridad

El destinatario **no se almacena en la base de datos**. Su nombre forma parte de la clave criptográfica junto con la clave secreta.

El mensaje se cifra con:

- PBKDF2 SHA-256
- 250.000 iteraciones
- salt aleatorio
- AES-GCM 256 bits
- IV aleatorio

El identificador del envío es un UUID aleatorio.

La tabla no concede acceso directo a `anon` ni `authenticated`. El navegador solo puede llamar a:

- `create_delivery(...)`
- `get_delivery(uuid)`

`get_delivery` no expone `failure_at` y no devuelve el ciphertext hasta que la entrega ha llegado.

### Limitación importante

Como la aplicación permite crear envíos sin login, un sitio público con mucho tráfico debería añadir protección anti-abuso (por ejemplo Turnstile/rate limiting mediante una Edge Function). Para un prototipo o una web pequeña, esta versión mantiene la arquitectura deliberadamente simple.

## Geocodificación

La demo usa el Nominatim público de OpenStreetMap únicamente al pulsar "Enviar", con dos búsquedas separadas más de un segundo y atribución visible.

Si la web empieza a tener tráfico real, usa un proveedor de geocodificación dedicado o un proxy/caché propio, ya que el Nominatim público tiene una política de uso estricta.
