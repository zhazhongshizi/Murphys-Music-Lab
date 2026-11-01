//! Isolated schema-11/readback/rollback evidence. Never opens the application DB.
#[cfg(test)]
mod tests {
    use crate::{
        persistence::*,
        personal::StoredQueue,
        queue::{QueueService, QueueTrack},
        smart_shuffle::SmartShuffle,
    };
    use rusqlite::params;
    use serde_json::{json, Value};
    #[test]
    fn schema11_all_storage_entries_and_matching_backup_roundtrip() {
        let root =
            std::env::temp_dir().join(format!("provider-3a-compat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("state.sqlite3");
        let side = root.join("state.shuffle.sqlite3");
        let legacy: StoredQueue = serde_json::from_str(include_str!(
            "../../../tests/fixtures/provider-v2/legacy-storage.json"
        ))
        .unwrap();
        let ids: Vec<_> = legacy.items.iter().map(|t| t.id.clone()).collect();
        let p = PersistenceService::open(&path).unwrap();
        assert_eq!(p.schema_version(), Ok(LOCAL_SCHEMA_VERSION));
        let persisted: Vec<_> = legacy
            .items
            .iter()
            .map(|t| PersistedTrack {
                video: None,
                track_id: t.id.clone(),
                media_mid: t.media_mid.clone(),
                title: t.title.clone(),
                artist: t.artist.clone(),
                album: t.album.clone(),
                duration_ms: t.duration_ms,
                cover_cache_key: t.cover_cache_key.clone(),
            })
            .collect();
        p.replace_queue(&persisted).unwrap();
        p.save_queue_selection(&ids[1]).unwrap();
        p.save_playback_mode("repeat-one").unwrap();
        p.save_playback_volume(0.42).unwrap();
        let mut settings = p.load_settings().unwrap();
        settings.last_position_ms = 54321;
        p.save_settings(&settings).unwrap();
        for t in &persisted {
            p.append_history(t, false).unwrap();
            p.record_listening(
                &t.track_id,
                &t.title,
                &t.artist,
                12345,
                true,
                crate::personal::now_ms(),
            )
            .unwrap();
        }
        p.save_mv_lyric_offset(&ids[0], 234).unwrap();
        p.save_named_queue("legacy", &legacy).unwrap();
        p.connection().unwrap().execute("INSERT INTO personal_items(kind,id,title,payload) VALUES('previous','previous','',?1)",[legacy.persisted_json().unwrap()]).unwrap();
        p.save_named_queue("deleted", &legacy).unwrap();
        p.delete_named_queue("deleted").unwrap();
        p.save_organizer_plan(&OrganizerPlanSummary {
            plan_id: "fixture-plan".into(),
            operation: OrganizerOperation::Copy,
            source_playlist_id: "123".into(),
            target_playlist_id: Some("456".into()),
            item_count: 1,
            completed_count: 0,
            failed_count: 0,
            expires_at_unix_ms: 123456,
            state: OrganizerPlanState::Preview,
        })
        .unwrap();
        p.save_organizer_plan_payload(
            "fixture-plan",
            &OrganizerPlanBinding {
                account_id: "123".into(),
                source_editable_id: "123".into(),
                target_editable_id: Some("456".into()),
                source_snapshot_hash: "a".repeat(64),
                target_snapshot_hash: Some("b".repeat(64)),
                created_at_unix_ms: 1000,
            },
            &[OrganizerPlanItem {
                track_id: ids[0].clone(),
                title: "Synthetic QQ".into(),
                artist: "Fixture".into(),
                phase: OrganizerItemPhase::Pending,
            }],
        )
        .unwrap();
        p.upsert_metadata(
            &MetadataCacheEntry {
                cache_key: "fixture_cache".into(),
                kind: MetadataKind::Track,
                stable_id: ids[0].clone(),
                display_name: "Synthetic QQ".into(),
                subtitle: "Fixture".into(),
                expires_at_unix_ms: u32::MAX as u64,
            },
            100,
        )
        .unwrap();
        let mut shuffle = SmartShuffle::new(side.clone());
        shuffle
            .set_enabled(
                true,
                &[(ids[0].clone(), 1234), (ids[1].clone(), 5678)],
                None,
            )
            .unwrap();
        drop(shuffle);
        let snapshot = root.join("before");
        std::fs::create_dir_all(&snapshot).unwrap();
        p.connection()
            .unwrap()
            .backup("main", snapshot.join("state.sqlite3"), None)
            .unwrap();
        let side_db = rusqlite::Connection::open(&side).unwrap();
        side_db
            .backup("main", snapshot.join("state.shuffle.sqlite3"), None)
            .unwrap();
        drop(side_db);
        let before = logical_rows(&p);
        drop(p);
        let p = PersistenceService::open(&path).unwrap();
        assert_eq!(logical_rows(&p), before);
        assert_eq!(p.load_queue().unwrap(), persisted);
        assert_eq!(
            p.load_playback_resume().unwrap(),
            (Some(ids[1].clone()), "repeat-one".into(), 0.42)
        );
        assert_eq!(p.load_settings().unwrap().last_position_ms, 54321);
        assert_eq!(p.mv_lyric_offset(&ids[0]), Ok(234));
        assert_eq!(p.load_named_queue(None).unwrap().items, legacy.items);
        assert_eq!(
            p.load_metadata("fixture_cache", 150)
                .unwrap()
                .unwrap()
                .stable_id,
            ids[0]
        );
        let history = p.load_playback_history().unwrap();
        assert_eq!(history.len(), 2);
        assert!(history
            .iter()
            .any(|t| t.id == ids[0] && t.media_mid == persisted[0].media_mid));
        assert_eq!(
            p.load_named_queue(Some("legacy")).unwrap().items,
            legacy.items
        );
        p.undo_delete_queue().unwrap();
        assert_eq!(
            p.load_named_queue(Some("deleted")).unwrap().items,
            legacy.items
        );
        let q = QueueService::open(&path).unwrap();
        let public = serde_json::to_value(q.snapshot()).unwrap();
        assert_eq!(public["items"][0]["providerId"], "qqmusic");
        assert_eq!(public["items"][1]["providerId"], "local");
        drop(q);
        let mixed:QueueTrack=serde_json::from_value(json!({"providerId":"netease","id":"netease:track:123","title":"Synthetic new","artist":"Fixture","album":"","durationMs":1000})).unwrap();
        let mixed_queue = StoredQueue {
            items: vec![mixed],
            selected_index: Some(0),
            saved_at_ms: 999,
        };
        p.save_named_queue("mixed", &mixed_queue).unwrap();
        assert_eq!(
            p.load_named_queue(Some("mixed")).unwrap().items[0].id,
            "netease:track:123"
        );
        // Exact old QueueTrack field whitelist, from the task-start code. Legacy
        // QQ/local JSON still fits; explicit mixed JSON is rejected by 1.3.3.
        let old = serde_json::from_str::<Value>(&legacy.persisted_json().unwrap()).unwrap();
        assert!(old["items"].as_array().unwrap().iter().all(old_shape));
        let new = serde_json::from_str::<Value>(&mixed_queue.persisted_json().unwrap()).unwrap();
        assert!(!old_shape(&new["items"][0]));
        drop(p);
        // Preserve new data, restore the *pair* of isolated pre-change snapshots.
        let new_data = root.join("after");
        std::fs::create_dir_all(&new_data).unwrap();
        let active = rusqlite::Connection::open(&path).unwrap();
        active
            .backup("main", new_data.join("state.sqlite3"), None)
            .unwrap();
        drop(active);
        let active_side = rusqlite::Connection::open(&side).unwrap();
        active_side
            .backup("main", new_data.join("state.shuffle.sqlite3"), None)
            .unwrap();
        drop(active_side);
        let restored = PersistenceService::open(&snapshot.join("state.sqlite3")).unwrap();
        assert_eq!(logical_rows(&restored), before);
        assert_eq!(restored.load_queue().unwrap(), persisted);
        drop(restored);
        let side_backup =
            rusqlite::Connection::open(snapshot.join("state.shuffle.sqlite3")).unwrap();
        let side_rows: Vec<(String, i64)> = side_backup
            .prepare("SELECT track_id,last_played_ms FROM listening_stats ORDER BY track_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            side_rows,
            vec![(ids[0].clone(), 1234), (ids[1].clone(), 5678)]
        );
        drop(side_backup);
        assert!(new_data.join("state.sqlite3").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn old_shape(v: &Value) -> bool {
        v.as_object().unwrap().keys().all(|k| {
            [
                "id",
                "mediaMid",
                "title",
                "artist",
                "album",
                "durationMs",
                "coverCacheKey",
            ]
            .contains(&k.as_str())
        })
    }
    fn logical_rows(p: &PersistenceService) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
        let db = p.connection().unwrap();
        let tables = [
            "queue_items",
            "playback_history",
            "playback_resume",
            "settings",
            "mv_lyric_offsets",
            "organizer_plan_items",
            "organizer_plans",
            "organizer_plan_bindings",
            "personal_items",
            "personal_deleted_queue",
            "listening_totals",
            "listening_daily",
            "listening_events",
            "listening_intervals",
            "listening_hourly",
            "metadata_cache",
        ];
        tables
            .into_iter()
            .map(|table| {
                let mut s = db
                    .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
                    .unwrap();
                let n = s.column_count();
                let rows = s
                    .query_map(params![], |r| {
                        (0..n)
                            .map(|i| r.get(i))
                            .collect::<rusqlite::Result<Vec<_>>>()
                    })
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                (table.to_string(), rows)
            })
            .collect()
    }
    #[test]
    fn new_track_source_is_required_and_consistent_without_changing_cache_rules() {
        let t = json!({"id":"netease:track:123","title":"Synthetic","artist":"Fixture","album":"","durationMs":1000});
        assert!(serde_json::from_value::<QueueTrack>(t.clone()).is_err());
        let mut t = t;
        t["providerId"] = json!("qqmusic");
        assert!(serde_json::from_value::<QueueTrack>(t.clone()).is_err());
        t["providerId"] = json!("netease");
        assert!(serde_json::from_value::<QueueTrack>(t).is_ok());
    }
}
