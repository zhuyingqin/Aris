//! Explicit SVG continuation from an immutable, already previewed PNG.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConfirmedRaster {
    pub id: String,
    pub index: usize,
    pub hash: String,
}

pub(super) fn validate_source(
    workspace: &Path,
    reference: &ConfirmedRaster,
    image: &api::GeneratedImage,
) -> Result<(), String> {
    let parent = store::load(workspace, &reference.id)?;
    if parent.pending_raster_edit.is_some() {
        return Err("请先应用图片修改结果。".into());
    }
    let original = raster::raster_image(workspace, &parent, reference.index)?;
    if reference.hash != store::hash(&original.bytes) || reference.hash != store::hash(&image.bytes)
    {
        return Err("图片版本已变更，请重新选择。".into());
    }
    Ok(())
}

pub(super) fn prepare_confirmed(
    workspace: &Path,
    id: &str,
    reference: &ConfirmedRaster,
) -> Result<FigureRun, String> {
    let run = store::load(workspace, id)?;
    if run.source_mode != "import" || !run.can_start() || id == reference.id {
        return Err("Invalid SVG continuation".into());
    }
    let image = api::validate_image_bytes(store::source(workspace, &run)?)?;
    validate_source(workspace, reference, &image)?;
    runtime::write_file_atomically(&store::directory(workspace, id)?.join("source.reference.json"),
        serde_json::to_vec_pretty(&json!({"figureId": reference.id, "rasterIndex": reference.index, "hash": reference.hash, "createdAt": runtime::now_iso8601()})).map_err(|e|e.to_string())?)
        .map_err(|e|e.to_string())?;
    raster::ensure_raster(workspace, id)?;
    store::update(workspace, id, |run| {
        if !run.can_start() || run.source_hash.as_deref() != Some(reference.hash.as_str()) {
            return Err("Image confirmation changed".into());
        }
        run.status = "image_ready".into();
        Ok(())
    })
    .map(|(run, ())| run)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_keeps_unknown_parent_and_its_saved_image_unchanged() {
        let workspace = tempfile::tempdir().unwrap();
        let parent_id = "a".repeat(32);
        let next_id = "b".repeat(32);
        let bytes = tools::figures::render("<svg xmlns='http://www.w3.org/2000/svg' width='4' height='3'><rect width='4' height='3' fill='red'/></svg>").unwrap().png;
        let run: FigureRun = serde_json::from_value(json!({
            "schemaVersion":1,"id":parent_id,"title":"ARMA","method":"ARMA inside reservoir","style":"paper","sourceMode":"import","sourceMime":"image/png","sourceHash":null,
            "status":"ready","outputLimit":0,"executor":ModelIdentity::default(),"reviewer":ModelIdentity::default(),"executorVision":false,"reviewerVision":false,"revisionUsed":false,
            "versions":[],"requests":[],"review":null,"error":null,"createdAt":"now","updatedAt":"now"
        })).unwrap();
        store::create(workspace.path(), run, Some(&bytes)).unwrap();
        raster::ensure_raster(workspace.path(), &parent_id).unwrap();
        let request = store::begin_request(
            workspace.path(),
            &parent_id,
            "manual_image_edit",
            "image",
            ModelIdentity::default(),
            0,
        )
        .unwrap();
        let (parent, ()) = store::update(workspace.path(), &parent_id, |run| {
            run.status = "unknown".into();
            run.requests[0].status = "unknown".into();
            run.error = Some("cancelled image edit".into());
            Ok(())
        })
        .unwrap();
        let image = api::validate_image_bytes(bytes.clone()).unwrap();
        let mut reference = ConfirmedRaster {
            id: parent_id.clone(),
            index: 1,
            hash: store::hash(&bytes),
        };
        reference.hash = "stale".into();
        assert!(validate_source(workspace.path(), &reference, &image).is_err());
        reference.hash = store::hash(&bytes);
        validate_source(workspace.path(), &reference, &image).unwrap();
        let mut next = parent.clone();
        next.id = next_id.clone();
        next.status = "ready".into();
        next.requests.clear();
        next.error = None;
        next.raster_versions.clear();
        next.source_hash = None;
        next.source_raster = None;
        store::create(workspace.path(), next, Some(&bytes)).unwrap();
        let prepared = prepare_confirmed(workspace.path(), &next_id, &reference).unwrap();
        assert!(prepared.can_confirm_image());
        assert_eq!(prepared.source_raster, Some(1));
        assert!(prepared.requests.is_empty());
        let confirmed = store::confirm_image(workspace.path(), &next_id, &reference.hash).unwrap();
        assert!(confirmed.image_confirmed);
        assert!(prepare_confirmed(workspace.path(), &next_id, &reference).is_err());
        let retained = store::load(workspace.path(), &parent_id).unwrap();
        assert_eq!(
            serde_json::to_value(retained).unwrap(),
            serde_json::to_value(parent).unwrap()
        );
        assert_eq!(
            store::read_artifact(
                workspace.path(),
                &parent_id,
                "raster-001.image",
                store::MAX_SOURCE_BYTES
            )
            .unwrap(),
            bytes
        );
        let audit: Value = serde_json::from_slice(
            &store::read_artifact(workspace.path(), &next_id, "source.reference.json", 10_000)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(audit["figureId"], parent_id);
        assert_eq!(audit["rasterIndex"], 1);
        assert_eq!(audit["hash"], reference.hash);
        assert_eq!(request.id, "request-01");
    }
}
