import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { SosClusterHourlyBucket, SosIncidentCluster, SupportResource } from '../types/lifeline.ts';

interface DivPixelLike {
  x: number;
  y: number;
}

interface MapProjectionLike {
  fromLatLngToDivPixel: (latLng: unknown) => DivPixelLike | null;
}

interface MapPanesLike {
  overlayMouseTarget: HTMLElement;
}

interface OverlayViewInstance {
  setMap(map: unknown | null): void;
  getProjection(): MapProjectionLike | null;
  getPanes(): MapPanesLike | null;
  onAdd?(): void;
  draw?(): void;
  onRemove?(): void;
}

interface GoogleMapsRuntime {
  LatLng: new (lat: number, lng: number) => unknown;
  OverlayView: new () => OverlayViewInstance;
}

interface D3GoogleMapsClusterOverlayProps {
  clusters: SosIncidentCluster[];
  selectedClusterId: string | null;
  onSelectCluster: (cluster: SosIncidentCluster) => void;
  visible: boolean;
}

export function D3GoogleMapsClusterOverlay({
  clusters,
  selectedClusterId,
  onSelectCluster,
  visible,
}: D3GoogleMapsClusterOverlayProps) {
  const map = useMap();
  const coreLib = useMapsLibrary('core');

  const clustersRef = useRef(clusters);
  const selectedIdRef = useRef(selectedClusterId);
  const visibleRef = useRef(visible);
  const onSelectRef = useRef(onSelectCluster);
  const overlayRef = useRef<OverlayViewInstance | null>(null);

  clustersRef.current = clusters;
  selectedIdRef.current = selectedClusterId;
  visibleRef.current = visible;
  onSelectRef.current = onSelectCluster;

  useEffect(() => {
    const gmaps = (window as unknown as { google?: { maps?: GoogleMapsRuntime } }).google?.maps;
    if (!map || !coreLib || !gmaps?.OverlayView || !gmaps?.LatLng) {
      return;
    }

    let containerDiv: HTMLDivElement | null = null;
    let svgEl: SVGSVGElement | null = null;

    class ClusterOverlay extends gmaps.OverlayView {
      onAdd() {
        containerDiv = document.createElement('div');
        containerDiv.style.position = 'absolute';
        containerDiv.style.left = '0px';
        containerDiv.style.top = '0px';
        containerDiv.style.pointerEvents = 'none';

        svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgEl.style.overflow = 'visible';
        svgEl.style.display = 'block';
        svgEl.style.pointerEvents = 'none';
        containerDiv.appendChild(svgEl);

        const panes = this.getPanes();
        if (panes?.overlayMouseTarget) {
          panes.overlayMouseTarget.appendChild(containerDiv);
        }
      }

      draw() {
        if (!containerDiv || !svgEl) return;
        const svg = d3.select(svgEl);

        if (!visibleRef.current || clustersRef.current.length === 0) {
          svg.selectAll('*').remove();
          return;
        }

        const projection = this.getProjection();
        if (!projection) return;

        const projected = clustersRef.current
          .map((cluster) => {
            const px = projection.fromLatLngToDivPixel(new gmaps!.LatLng(cluster.lat, cluster.lng));
            if (!px || !Number.isFinite(px.x) || !Number.isFinite(px.y)) return null;
            return { cluster, x: px.x, y: px.y };
          })
          .filter((item): item is { cluster: SosIncidentCluster; x: number; y: number } => item !== null);

        if (projected.length === 0) {
          svg.selectAll('*').remove();
          return;
        }

        const pad = 180;
        const minX = Math.floor(d3.min(projected, (d) => d.x)! - pad);
        const maxX = Math.ceil(d3.max(projected, (d) => d.x)! + pad);
        const minY = Math.floor(d3.min(projected, (d) => d.y)! - pad);
        const maxY = Math.ceil(d3.max(projected, (d) => d.y)! + pad);
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);

        containerDiv.style.left = `${minX}px`;
        containerDiv.style.top = `${minY}px`;
        containerDiv.style.width = `${width}px`;
        containerDiv.style.height = `${height}px`;

        svgEl.setAttribute('width', String(width));
        svgEl.setAttribute('height', String(height));
        svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);

        const zoom = (map as unknown as { getZoom?: () => number }).getZoom?.() ?? 13;
        const maxCount = Math.max(1, d3.max(projected, (d) => d.cluster.totalCount) ?? 1);
        const bubbleRadius = d3.scaleSqrt<number, number>().domain([1, maxCount]).range([16, 36]);
        const verifiedColor = d3.interpolateRgb('#F59E0B', '#E11D48');

        const nodes = svg
          .selectAll<SVGGElement, { cluster: SosIncidentCluster; x: number; y: number }>('g.sos-cluster-node')
          .data(projected, (d) => d.cluster.id);

        nodes.exit().remove();

        const entered = nodes
          .enter()
          .append('g')
          .attr('class', 'sos-cluster-node')
          .style('pointer-events', 'all')
          .style('cursor', 'pointer');

        entered.append('circle').attr('class', 'cluster-halo');
        entered.append('circle').attr('class', 'cluster-ring');
        entered.append('circle').attr('class', 'cluster-core');
        entered.append('text').attr('class', 'cluster-count');
        entered.append('text').attr('class', 'cluster-tag');

        const merged = entered.merge(nodes);
        merged.attr('transform', (d) => `translate(${d.x - minX}, ${d.y - minY})`);

        merged.on('click', (event: MouseEvent, d) => {
          event.stopPropagation();
          onSelectRef.current(d.cluster);
        });

        merged
          .select<SVGCircleElement>('circle.cluster-halo')
          .attr('r', (d) => {
            const metersPerPx =
              (156543.03392 * Math.cos((d.cluster.lat * Math.PI) / 180)) / Math.pow(2, zoom);
            const geoPx = metersPerPx > 0 ? d.cluster.radiusMeters / metersPerPx : 42;
            return Math.max(bubbleRadius(d.cluster.totalCount) + 12, Math.min(150, geoPx));
          })
          .attr('fill', (d) =>
            d.cluster.dataOrigin === 'simulated'
              ? '#38BDF8'
              : verifiedColor(Math.min(1, d.cluster.severityScore / 100))
          )
          .attr('fill-opacity', (d) => (d.cluster.id === selectedIdRef.current ? 0.24 : 0.14))
          .attr('stroke', (d) =>
            d.cluster.dataOrigin === 'simulated'
              ? '#38BDF8'
              : verifiedColor(Math.min(1, d.cluster.severityScore / 100))
          )
          .attr('stroke-width', (d) => (d.cluster.id === selectedIdRef.current ? 2.2 : 1.25))
          .attr('stroke-dasharray', (d) => (d.cluster.dataOrigin === 'simulated' ? '5 4' : '3 3'))
          .attr('stroke-opacity', 0.72);

        merged
          .select<SVGCircleElement>('circle.cluster-ring')
          .attr('r', (d) => bubbleRadius(d.cluster.totalCount) + 4)
          .attr('fill', 'none')
          .attr('stroke', (d) =>
            d.cluster.id === selectedIdRef.current
              ? '#FFFFFF'
              : d.cluster.dataOrigin === 'simulated'
              ? '#38BDF8'
              : '#FFE4E6'
          )
          .attr('stroke-width', (d) => (d.cluster.id === selectedIdRef.current ? 2.5 : 1))
          .attr('stroke-opacity', (d) => (d.cluster.id === selectedIdRef.current ? 0.95 : 0.45));

        merged
          .select<SVGCircleElement>('circle.cluster-core')
          .attr('r', (d) => bubbleRadius(d.cluster.totalCount))
          .attr('fill', (d) =>
            d.cluster.dataOrigin === 'simulated'
              ? '#0A1633'
              : verifiedColor(Math.min(1, d.cluster.severityScore / 100))
          )
          .attr('fill-opacity', 0.92)
          .attr('stroke', (d) => (d.cluster.dataOrigin === 'simulated' ? '#38BDF8' : '#FFFFFF'))
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', (d) => (d.cluster.dataOrigin === 'simulated' ? '4 2' : 'none'));

        merged
          .select<SVGTextElement>('text.cluster-count')
          .attr('text-anchor', 'middle')
          .attr('dy', (d) => (d.cluster.dataOrigin === 'simulated' ? '0.1em' : '0.35em'))
          .attr('fill', '#FFFFFF')
          .attr('font-size', '12px')
          .attr('font-weight', '700')
          .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
          .text((d) => String(d.cluster.totalCount));

        merged
          .select<SVGTextElement>('text.cluster-tag')
          .attr('text-anchor', 'middle')
          .attr('dy', '1.25em')
          .attr('fill', '#7DD3FC')
          .attr('font-size', '8px')
          .attr('font-weight', '700')
          .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
          .text((d) => (d.cluster.dataOrigin === 'simulated' ? 'DEMO' : ''));
      }

      onRemove() {
        if (containerDiv?.parentNode) {
          containerDiv.parentNode.removeChild(containerDiv);
        }
        containerDiv = null;
        svgEl = null;
      }
    }

    const overlay = new ClusterOverlay();
    overlay.setMap(map);
    overlayRef.current = overlay;

    return () => {
      overlay.setMap(null);
      overlayRef.current = null;
    };
  }, [map, coreLib]);

  useEffect(() => {
    overlayRef.current?.draw?.();
  }, [clusters, selectedClusterId, visible]);

  return null;
}

interface D3SpatialFallbackClusterMapProps {
  center: { lat: number; lng: number };
  clusters: SosIncidentCluster[];
  resources: SupportResource[];
  selectedClusterId: string | null;
  showClusters: boolean;
  onSelectCluster: (cluster: SosIncidentCluster) => void;
  onSelectResource: (resource: SupportResource) => void;
}

export function D3SpatialFallbackClusterMap({
  center,
  clusters,
  resources,
  selectedClusterId,
  showClusters,
  onSelectCluster,
  onSelectResource,
}: D3SpatialFallbackClusterMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ label: string; sub: string } | null>(null);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const width = 880;
    const height = 460;
    const pad = 54;

    const allPoints: Array<[number, number]> = [[center.lng, center.lat]];
    if (showClusters) {
      clusters.forEach((c) => allPoints.push([c.lng, c.lat]));
    }
    resources.slice(0, 12).forEach((r) => allPoints.push([r.longitude, r.latitude]));

    // Ensure non-zero bounding box around reference center so geoMercator scales cleanly even with 1 point
    allPoints.push([center.lng - 0.035, center.lat - 0.025]);
    allPoints.push([center.lng + 0.035, center.lat + 0.025]);

    const featureCollection = {
      type: 'FeatureCollection' as const,
      features: allPoints.map(([lng, lat]) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Point' as const,
          coordinates: [lng, lat],
        },
      })),
    };

    const projection = d3
      .geoMercator()
      .fitExtent(
        [
          [pad, pad],
          [width - pad, height - pad],
        ],
        featureCollection as never
      );

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    // Subtle radar grid
    const gridGroup = svg.append('g').attr('class', 'spatial-grid');
    for (let x = 80; x < width; x += 80) {
      gridGroup
        .append('line')
        .attr('x1', x)
        .attr('y1', 0)
        .attr('x2', x)
        .attr('y2', height)
        .attr('stroke', 'rgba(148, 163, 184, 0.14)')
        .attr('stroke-dasharray', '3 5');
    }
    for (let y = 76; y < height; y += 76) {
      gridGroup
        .append('line')
        .attr('x1', 0)
        .attr('y1', y)
        .attr('x2', width)
        .attr('y2', y)
        .attr('stroke', 'rgba(148, 163, 184, 0.14)')
        .attr('stroke-dasharray', '3 5');
    }

    // Nearby support directory markers
    const supportGroup = svg.append('g').attr('class', 'support-nodes');
    resources.slice(0, 14).forEach((res) => {
      const pt = projection([res.longitude, res.latitude]);
      if (!pt) return;
      const g = supportGroup
        .append('g')
        .attr('transform', `translate(${pt[0]}, ${pt[1]})`)
        .style('cursor', 'pointer')
        .on('mouseenter', () => setHoverInfo({ label: res.name, sub: `${res.category} · ${res.phone}` }))
        .on('mouseleave', () => setHoverInfo(null))
        .on('click', () => onSelectResource(res));

      g.append('circle')
        .attr('r', 7)
        .attr('fill', '#7C3AED')
        .attr('stroke', '#DDD6FE')
        .attr('stroke-width', 1.8);
    });

    // D3 SOS Incident Clusters layer
    if (showClusters && clusters.length > 0) {
      const maxCount = Math.max(1, d3.max(clusters, (c) => c.totalCount) ?? 1);
      const bubbleScale = d3.scaleSqrt<number, number>().domain([1, maxCount]).range([16, 36]);
      const verifiedColor = d3.interpolateRgb('#F59E0B', '#E11D48');

      const clusterGroup = svg.append('g').attr('class', 'd3-fallback-clusters');
      clusters.forEach((c) => {
        const pt = projection([c.lng, c.lat]);
        if (!pt) return;
        const r = bubbleScale(c.totalCount);
        const haloR = Math.min(92, Math.max(r + 14, c.radiusMeters / 16));
        const fill = c.dataOrigin === 'simulated' ? '#0A1633' : verifiedColor(Math.min(1, c.severityScore / 100));
        const stroke = c.dataOrigin === 'simulated' ? '#38BDF8' : '#FFFFFF';
        const isSelected = c.id === selectedClusterId;

        const g = clusterGroup
          .append('g')
          .attr('transform', `translate(${pt[0]}, ${pt[1]})`)
          .style('cursor', 'pointer')
          .on('mouseenter', () =>
            setHoverInfo({
              label: `${c.totalCount} ${c.dataOrigin === 'simulated' ? 'Demo ' : ''}SOS Cluster · ${c.dominantCategory}`,
              sub: `Cell (${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}) · Radius ~${c.radiusMeters}m`,
            })
          )
          .on('mouseleave', () => setHoverInfo(null))
          .on('click', () => onSelectCluster(c));

        g.append('circle')
          .attr('r', haloR)
          .attr('fill', c.dataOrigin === 'simulated' ? '#38BDF8' : fill)
          .attr('fill-opacity', isSelected ? 0.25 : 0.14)
          .attr('stroke', c.dataOrigin === 'simulated' ? '#38BDF8' : fill)
          .attr('stroke-width', isSelected ? 2 : 1.2)
          .attr('stroke-dasharray', c.dataOrigin === 'simulated' ? '5 4' : '3 3');

        if (isSelected) {
          g.append('circle')
            .attr('r', r + 5)
            .attr('fill', 'none')
            .attr('stroke', '#FFFFFF')
            .attr('stroke-width', 2);
        }

        g.append('circle')
          .attr('r', r)
          .attr('fill', fill)
          .attr('fill-opacity', 0.94)
          .attr('stroke', stroke)
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', c.dataOrigin === 'simulated' ? '4 2' : 'none');

        g.append('text')
          .attr('text-anchor', 'middle')
          .attr('dy', c.dataOrigin === 'simulated' ? '0.1em' : '0.35em')
          .attr('fill', '#FFFFFF')
          .attr('font-size', '12px')
          .attr('font-weight', '700')
          .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
          .text(String(c.totalCount));

        if (c.dataOrigin === 'simulated') {
          g.append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', '1.25em')
            .attr('fill', '#7DD3FC')
            .attr('font-size', '8px')
            .attr('font-weight', '700')
            .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
            .text('DEMO');
        }
      });
    }

    // Active User Reference Position Reticle
    const userPt = projection([center.lng, center.lat]);
    if (userPt) {
      const ug = svg.append('g').attr('transform', `translate(${userPt[0]}, ${userPt[1]})`);
      ug.append('circle').attr('r', 18).attr('fill', '#E11D48').attr('fill-opacity', 0.18);
      ug.append('circle').attr('r', 7).attr('fill', '#E11D48').attr('stroke', '#FFFFFF').attr('stroke-width', 2);
    }
  }, [center, clusters, resources, selectedClusterId, showClusters, onSelectCluster, onSelectResource]);

  return (
    <div className="relative h-[460px] w-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-[#060B19]">
      <svg
        ref={svgRef}
        viewBox="0 0 880 460"
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full select-none"
        role="img"
        aria-label="D3.js Geospatial SOS Incident Cluster Awareness Canvas"
      />
      <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-sky-400/30 bg-[#081026]/90 px-3 py-1.5 text-[11px] text-slate-200 backdrop-blur">
        D3.js Mercator Cluster Canvas (Google Maps tile key unavailable in current environment)
      </div>
      {hoverInfo && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-white/15 bg-[#081026]/95 px-3 py-2 text-xs text-white shadow-lg">
          <div className="font-semibold">{hoverInfo.label}</div>
          <div className="text-[11px] text-slate-300">{hoverInfo.sub}</div>
        </div>
      )}
    </div>
  );
}

interface D3HourlyIncidentChartProps {
  hourlyDistribution: SosClusterHourlyBucket[];
}

export function D3HourlyIncidentChart({ hourlyDistribution }: D3HourlyIncidentChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [activeBucket, setActiveBucket] = useState<SosClusterHourlyBucket | null>(null);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || hourlyDistribution.length === 0) return;

    const width = 560;
    const height = 148;
    const margin = { top: 14, right: 12, bottom: 24, left: 26 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const g = svg.append('g').attr('transform', `translate(${margin.left}, ${margin.top})`);

    const x = d3
      .scaleBand<number>()
      .domain(hourlyDistribution.map((d) => d.hour))
      .range([0, innerW])
      .padding(0.24);

    const maxTotal = Math.max(
      2,
      d3.max(hourlyDistribution, (d) => d.verifiedCount + d.simulatedCount) ?? 2
    );

    const y = d3.scaleLinear().domain([0, maxTotal]).nice().range([innerH, 0]);

    // Grid horizontal lines
    const yTicks = y.ticks(3);
    g.selectAll('line.hgrid')
      .data(yTicks)
      .enter()
      .append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', (d) => y(d))
      .attr('y2', (d) => y(d))
      .attr('stroke', 'rgba(148, 163, 184, 0.2)')
      .attr('stroke-dasharray', '2 3');

    // Area curve for verified signal envelope
    const areaGen = d3
      .area<SosClusterHourlyBucket>()
      .x((d) => (x(d.hour) ?? 0) + x.bandwidth() / 2)
      .y0(innerH)
      .y1((d) => y(d.verifiedCount))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(hourlyDistribution)
      .attr('fill', 'rgba(225, 29, 72, 0.16)')
      .attr('d', areaGen);

    // Bars (verified bottom, simulated stacked on top)
    const bars = g
      .selectAll('g.hour-bar')
      .data(hourlyDistribution)
      .enter()
      .append('g')
      .style('cursor', 'pointer')
      .on('mouseenter', (_e, d) => setActiveBucket(d))
      .on('mouseleave', () => setActiveBucket(null));

    bars
      .append('rect')
      .attr('x', (d) => x(d.hour) ?? 0)
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.verifiedCount))
      .attr('height', (d) => Math.max(0, innerH - y(d.verifiedCount)))
      .attr('rx', 2)
      .attr('fill', '#E11D48');

    bars
      .append('rect')
      .attr('x', (d) => x(d.hour) ?? 0)
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.verifiedCount + d.simulatedCount))
      .attr('height', (d) => Math.max(0, y(d.verifiedCount) - y(d.verifiedCount + d.simulatedCount)))
      .attr('rx', 2)
      .attr('fill', '#38BDF8')
      .attr('fill-opacity', 0.85);

    // X-axis hour labels (every 6h)
    [0, 6, 12, 18, 23].forEach((hr) => {
      const cx = (x(hr) ?? 0) + x.bandwidth() / 2;
      g.append('text')
        .attr('x', cx)
        .attr('y', innerH + 16)
        .attr('text-anchor', 'middle')
        .attr('fill', '#94A3B8')
        .attr('font-size', '10px')
        .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
        .text(`${String(hr).padStart(2, '0')}h`);
    });

    // Y-axis max label
    yTicks.forEach((tk) => {
      g.append('text')
        .attr('x', -6)
        .attr('y', y(tk) + 3)
        .attr('text-anchor', 'end')
        .attr('fill', '#94A3B8')
        .attr('font-size', '9px')
        .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
        .text(String(tk));
    });
  }, [hourlyDistribution]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span>Hourly Activity Window (UTC)</span>
        <span className="font-mono">
          {activeBucket
            ? `${String(activeBucket.hour).padStart(2, '0')}:00 UTC · Verified: ${activeBucket.verifiedCount} · Demo: ${activeBucket.simulatedCount}`
            : 'Hover bar to inspect hourly verified vs. demo counts'}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox="0 0 560 148"
        className="w-full h-36 overflow-visible"
        role="img"
        aria-label="D3.js 24-hour SOS cluster activity chart"
      />
    </div>
  );
}
