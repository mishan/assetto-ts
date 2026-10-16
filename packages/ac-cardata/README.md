# ac-cardata

Reads what an Assetto Corsa car's own data says about it: its `data/` folder,
or the same files packed into `data.acd`, and the numbers in them that place
things on the car.

```ts
import { carDriverEyes, carWheels, readCarFile, parseIni } from "ac-cardata"

const cars = "/path/to/assettocorsa/content/cars"
await carDriverEyes(cars, "abarth500") // [0.330737, 1.19075, -0.490002]
await carWheels(cars, "abarth500")     // four wheel centres, FL, FR, RL, RR

const ini = await readCarFile(`${cars}/abarth500`, "car.ini")
parseIni(ini!.toString("latin1")).get("BASIC")?.get("TOTALMASS")
```

- **Files:** `readCarFile(carDir, name)` takes the unpacked `data/` folder
  first, as the game does, and the archive otherwise. The archive's key comes
  from the folder's name, so `carDir` must be named as the game names the car.
  `readAcd(buffer, folder)` opens an archive you already hold.
- **Driver's eyes:** `[GRAPHICS] DRIVEREYES`, the cockpit camera, in the frame
  of the car's 3D model: `[BASIC] GRAPHICS_OFFSET` does not apply. +x is the
  car's left, +y up, +z forward.
- **Wheels:** from `suspensions.ini`, relative to the car's position as the
  game reports it, which is its centre of gravity.

Checked against all 245 archives on one install, and the eyes against where
the steering wheel puts them on two cars' models.
