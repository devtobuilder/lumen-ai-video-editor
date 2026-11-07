import { Euler, Vector3, type Box3 } from 'three'
import { safeTextWidth } from '../text-layout'

/** Scale only the rendered geometry to keep its projected horizontal footprint
 * safe, including extrusion, perspective and rotation. Placement is unchanged.
 */
export function fitProjectedText(box: Box3, width: number, distance: number, p: { x: number; z: number; scale: number; rotation: number; rotateX: number; rotateY: number }) {
  if (distance <= 0 || distance - p.z <= 0 || p.scale <= 0) return 1
  const rad = Math.PI / 180
  const rotation = new Euler(-p.rotateX * rad, p.rotateY * rad, -p.rotation * rad, 'YXZ')
  const points: Vector3[] = []
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) points.push(new Vector3(x, y, z).applyEuler(rotation))
  const center = p.x * distance / (distance - p.z)
  const available = safeTextWidth(width, center)
  const span = (fit: number) => {
    let half = 0
    for (const point of points) {
      const scale = p.scale * fit
      const depth = distance - p.z - point.z * scale
      if (depth <= distance * 0.01) return Infinity
      const x = (p.x + point.x * scale) * distance / depth
      half = Math.max(half, Math.abs(x - center))
    }
    return half * 2
  }
  if (span(1) <= available) return 1
  let lo = 0, hi = 1
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (span(mid) <= available) lo = mid
    else hi = mid
  }
  return lo
}
