export interface BgmSubject {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  summary: string;
  date: string;
  images: {
    large: string;
    common: string;
    medium: string;
    small: string;
    grid: string;
  };
  total_episodes: number;
  tags?: { name: string }[];
}

export interface BgmEpisode {
  airdate: string;
  name: string;
  name_cn: string;
  duration: string;
  desc: string;
  ep: number;
  sort: number;
  id: number;
  subject_id: number;
  type: number;
  duration_seconds: number;
}
