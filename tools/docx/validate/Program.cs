using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

// Read-only schema validation complements rendering; it does not certify
// pagination or target-editor fidelity. Existing upstream schema errors are
// counted separately when a baseline is provided.
if (args.Length is < 1 or > 2)
    throw new ArgumentException("Usage: DocxValidate candidate.docx [baseline.docx]");

List<Dictionary<string,string?>> Inspect(string path)
{
    using var document = WordprocessingDocument.Open(path, false);
    var validator = new OpenXmlValidator(FileFormatVersions.Office2019) { MaxNumberOfErrors = 1000 };
    return validator.Validate(document).Select(error => new Dictionary<string,string?> {
        ["id"] = error.Id, ["description"] = error.Description,
        ["part"] = error.Part?.Uri.ToString(), ["path"] = error.Path?.XPath
    }).ToList();
}

string Key(Dictionary<string,string?> error) => $"{error["id"]}|{error["part"]}|{error["description"]}";
var candidate = Inspect(args[0]);
var baseline = args.Length == 2 ? Inspect(args[1]) : new();
var remaining = baseline.GroupBy(Key).ToDictionary(group => group.Key, group => group.Count());
var added = new List<Dictionary<string,string?>>();
foreach (var error in candidate)
{
    var key = Key(error);
    if (remaining.TryGetValue(key, out var count) && count > 0) remaining[key]--;
    else added.Add(error);
}
Console.WriteLine(JsonSerializer.Serialize(new { candidate, baseline, added }, new JsonSerializerOptions { WriteIndented = true }));
return added.Count == 0 ? 0 : 1;
